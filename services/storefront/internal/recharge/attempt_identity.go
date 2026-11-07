package recharge

import (
	"context"
	"errors"

	"gptibo/storefront/internal/orders"
)

// A pre-upgrade task ID can be known while its ordinal is not. Learn only
// from the original order's upstream list or a read of that exact bound task;
// rejected local requests never supply evidence for a platform ordinal.
func (s *Service) bindLegacyAttemptNumbers(ctx context.Context, r Row, refs []fulfillmentRef) error {
	if r.Remote == nil {
		return nil
	}
	rows, err := orders.Rows(ctx, s.Store.DB, `SELECT id,remote_id FROM recharge_redemptions WHERE order_id=$1 AND remote_id IS NOT NULL AND remote_attempt_no IS NULL ORDER BY attempt_no`, r.OrderID)
	if err != nil || len(rows) == 0 {
		return err
	}
	type binding struct {
		id, remote string
		number     int64
	}
	bindings := make([]binding, 0, len(rows))
	for _, row := range rows {
		b := binding{id: row["id"].(string), remote: row["remote_id"].(string)}
		for _, ref := range refs {
			if ref.ID == b.remote {
				if ref.Order != *r.Remote || (b.number != 0 && b.number != ref.Number) {
					return errors.New("legacy task identity mismatch")
				}
				b.number = ref.Number
			}
		}
		if b.number == 0 {
			if !remoteID.MatchString(b.remote) {
				return errors.New("invalid legacy task identity")
			}
			var v Redemption
			if err = s.Client.Request(ctx, "/redemptions/"+b.remote, nil, "", &v); err != nil {
				return err
			}
			if v.ID != b.remote || v.Order != *r.Remote || v.Attempt == nil {
				return errors.New("unconfirmed legacy task identity")
			}
			b.number = *v.Attempt
		}
		if b.number < 1 || b.number > 9007199254740991 {
			return errors.New("invalid legacy task number")
		}
		bindings = append(bindings, b)
	}
	tx, err := s.Store.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = orders.Get(ctx, tx, r.OrderID, nil, true); err != nil {
		return err
	}
	if _, err = s.fence(ctx, tx, r); err != nil {
		return err
	}
	for _, b := range bindings {
		result, e := tx.Exec(ctx, `UPDATE recharge_redemptions SET remote_attempt_no=$1 WHERE id=$2 AND order_id=$3 AND remote_id=$4 AND (remote_attempt_no IS NULL OR remote_attempt_no=$1)`, b.number, b.id, r.OrderID, b.remote)
		if e != nil {
			return e
		}
		if result.RowsAffected() != 1 {
			return orders.Conflict()
		}
	}
	var unordered bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM (SELECT remote_attempt_no,lag(remote_attempt_no) OVER(ORDER BY attempt_no) previous FROM recharge_redemptions WHERE order_id=$1 AND remote_id IS NOT NULL AND remote_attempt_no IS NOT NULL) a WHERE remote_attempt_no<=previous)`, r.OrderID).Scan(&unordered)
	if err != nil {
		return err
	}
	if unordered {
		return errors.New("legacy task ordinal conflicts with accepted history")
	}
	return tx.Commit(ctx)
}
