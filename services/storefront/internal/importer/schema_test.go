package importer

import (
	"reflect"
	"strings"
	"testing"
)

func TestSchemaDigestLineEndingsAndChangedContent(t *testing.T) {
	lf := strings.ReplaceAll(string(schema), "\r\n", "\n")
	for _, v := range []string{lf, strings.ReplaceAll(lf, "\n", "\r\n")} {
		if !supportedSchema(hash([]byte(v))) {
			t.Fatal("line ending compatibility lost")
		}
	}
	if supportedSchema(hash([]byte(strings.Replace(lf, "order_id", "changed_id", 1)))) {
		t.Fatal("changed schema accepted")
	}
}

func TestNewFinancialAndAttemptFieldsRemainExact(t *testing.T) {
	report := Report{Review: map[string]int64{}}
	for _, sample := range []struct {
		table string
		row   Row
	}{
		{"recharge_redemptions", Row{"attempt_no": text("2"), "remote_attempt_no": text("1"), "remote_id": text("original-task")}},
		{"delivery_supplier_orders", Row{"actual_usd_cents": text("123"), "actual_usd_micros": text("1234567")}},
	} {
		mapped, err := transform(sample.table, sample.row, 0, &report)
		if err != nil || !reflect.DeepEqual(mapped[sample.table][0], sample.row) {
			t.Fatal("financial or attempt mapping lost precision", sample.table, err)
		}
	}
	legacy, err := transform("recharge_redemptions", Row{"attempt_no": text("2"), "remote_id": text("old-task")}, 0, &report)
	if err != nil || legacy["recharge_redemptions"][0]["remote_attempt_no"] != nil {
		t.Fatal("legacy ordinal was inferred", err)
	}
}
