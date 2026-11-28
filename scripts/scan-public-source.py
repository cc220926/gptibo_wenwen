#!/usr/bin/env python3
"""Check tracked source (or an exported tree) without printing matched values.

This is a release guard for private artifacts and unexpected outbound hosts.
Run Gitleaks as well; neither check is a guarantee against all disclosures.
"""
import argparse
import hashlib
import ipaddress
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

PUBLIC_HOSTS = {
    'api.cloudflare.com', 'challenges.cloudflare.com', 'developers.cloudflare.com',
    'api.resend.com', 'api.telegram.org', 'open.feishu.cn', 't.me',
    'qyapi.weixin.qq.com', 'sctapi.ftqq.com', 'push.ft07.com', 'open.larksuite.com',
    'openapi.alipay.com', 'openapi-sandbox.dl.alipaydev.com', 'qr.alipay.com',
    'api.z-pay.cn', 'zpayz.cn', 'mzf.mapay.cn', 'api.gptibo.com',
    'chatgpt.com', 'api.openai.com', 'cdn.auth0.com',
    'github.com', 'raw.githubusercontent.com', 'registry.npmjs.org',
    # XML sitemap namespace, not an outbound service integration.
    'www.sitemaps.org',
    # JSON-LD vocabulary identifier in public HTML, never fetched by the Worker.
    'schema.org',
    # Operator-run indexing notifications (scripts/seo/push-indexing.mjs); the Worker never calls them.
    'api.indexnow.org', 'data.zz.baidu.com',
    'www.w3.org', 'www.apache.org', 'ui.shadcn.com', 'transitions.dev', 'vite.dev',
    'www.duolingo.com', 'www.duolingo.cn', 'd35aaqx5ub95lt.cloudfront.net',
}
BINARY_ASSETS = {'public/email-logo.png', 'public/email-shop.png', 'src/assets/hero.png'}
# Reviewed testimonial pixels; changed files must be reviewed again.
REVIEWED_BINARY_ASSETS = {
    'public/feedback/service-feedback.png': '2bfb81c197fb9831c07cc6fad0637c94b60f9f5a371c3bdec32f0608f1e15505',
    'public/feedback/renewal-inquiry.png': '24ed5dbbfd311321edfabc5eea53c097c9345a8b3c298e040ce0e95045b1009e',
    'public/feedback/refund-conversation.png': 'd83f6e8d2baf5c77941036a8d5fbc4023ac6ea2018045fec1785891085ab7c75',
    'public/feedback/friend-referral.png': 'badbf0db08cdcb58a5529195feaba4cb8853d1dc26143eb27744fcd57d699bdd',
    'public/feedback/activation-followup.png': 'f7a036cbdceeab1881500dd05012bd151bd8ea1f492ba2837360d45be222c653',
    'public/feedback/early-renewal.png': 'd0c8081305b9dee2c28be2cc6311b68801df03a4ff88689d8496b2510c68e622',
    'public/feedback/recharge-confirmed.png': '5aae4f41151039f8f2d1056dca37af8559352cdfe8f2d08248ce78f2de04d3ac',
}
FORBIDDEN_PARTS = {'.git', '.secrets', '.imports', '.admin-auth', '.xgift-private',
                   'node_modules', 'dist', '.preview', '.wrangler', 'artifacts', '__pycache__'}
FORBIDDEN_SUFFIXES = {'.pem', '.key', '.p12', '.pfx', '.sqlite', '.db', '.dump',
                      '.backup', '.har', '.log', '.zip', '.gz', '.exe'}
SECRET = re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/]{20}')
TOKEN = re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{30,})\b')
URL = re.compile(r'https?://[A-Za-z0-9_.:@/-]+')
CLOUD_ID = re.compile(r'"(?:account_id|zone_id|database_id)"\s*:\s*"([a-fA-F0-9-]+)"')


def allowed_host(host):
    host = host.lower()
    if host in PUBLIC_HOSTS or host in {'localhost', '127.0.0.1', '0.0.0.0', '::1', 'example.com', 'example.org', 'example.net'}:
        return True
    if host.endswith(('.example.com', '.example.org', '.example.net', '.example', '.test', '.invalid')):
        return True
    # Explicit test fixtures for public authentication infrastructure.
    if host == 'team.cloudflareaccess.com':
        return True
    try:
        return not ipaddress.ip_address(host).is_global
    except ValueError:
        return False


def scan(root, files):
    findings = []
    for name in sorted(files):
        path = root / name
        if path.is_symlink():
            findings.append((name, 0, 'symlink forbidden in public export'))
            continue
        if not path.exists():
            continue  # Deleted tracked file in a preparation branch.
        if not path.is_file():
            continue
        parts = Path(name).parts
        if (FORBIDDEN_PARTS.intersection(parts) or path.suffix in FORBIDDEN_SUFFIXES
                or (path.name.startswith('.env') and not path.name.endswith('.example'))
                or (path.name.startswith('.dev.vars') and not path.name.endswith('.example'))
                or name.startswith(('services/platform/', 'services/xgift/'))):
            findings.append((name, 0, 'private/runtime artifact'))
            continue
        data = path.read_bytes()
        if name in REVIEWED_BINARY_ASSETS:
            if hashlib.sha256(data).hexdigest() != REVIEWED_BINARY_ASSETS[name] or not data.startswith(b'\x89PNG\r\n\x1a\n'):
                findings.append((name, 0, 'reviewed binary asset changed'))
            continue
        try:
            source = data.decode('utf-8')
        except UnicodeDecodeError:
            if name not in BINARY_ASSETS or not data.startswith(b'\x89PNG\r\n\x1a\n'):
                findings.append((name, 0, 'unreviewed binary asset'))
            continue
        for rule, pattern in [('private key', SECRET), ('credential token', TOKEN)]:
            for match in pattern.finditer(source):
                findings.append((name, source.count('\n', 0, match.start()) + 1, rule))
        for match in CLOUD_ID.finditer(source):
            if set(match.group(1)) - {'0', '-'}:
                findings.append((name, source.count('\n', 0, match.start()) + 1, 'non-placeholder cloud resource ID'))
        if path.name == 'package-lock.json':
            continue  # Dependency integrity is checked by npm ci and Gitleaks.
        for line, text in enumerate(source.splitlines(), 1):
            for match in URL.finditer(text):
                try:
                    parsed_url = urlsplit(match.group())
                    host = parsed_url.hostname or ''
                except ValueError:
                    findings.append((name, line, 'malformed URL requires review'))
                    continue
                # Ignore templates and incomplete expression/regex fragments.
                if '.' not in host or host.endswith('.'):
                    continue
                # Existing public storefront URL in the historical release record only.
                documented_storefront = name == 'docs/seo-production-release.md' and host == 'gptpay1688.com'
                # Public buyer-facing link. Scoping this to the mail template and its fixture
                # leaves every other reference to that host subject to the normal guard.
                codex_redemption = parsed_url.scheme == 'https' and (name, parsed_url.netloc, parsed_url.path) in (
                    ('shared/codex-sms-redemption.ts', 'ai.aikm.workers.dev', '/'),
                    ('tests/muse-native.test.ts', 'ai.aikm.workers.dev', '/'),
                    ('tests/muse-native.test.ts', 'ai.aikm.workers.dev', '/guide'),
                    ('tests/muse-native.test.ts', 'sms.llvi.de', '/'),
                )
                if not allowed_host(host) and not documented_storefront and not codex_redemption:
                    findings.append((name, line, 'unexpected external host'))
    return sorted(set(findings))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tree', type=Path, help='scan an exported source directory, including hidden files')
    args = parser.parse_args()
    if args.tree:
        root = args.tree.resolve()
        files = [str(p.relative_to(root)) for p in root.rglob('*') if p.is_file() or p.is_symlink()]
    else:
        root = Path(__file__).resolve().parents[1]
        files = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root).decode().split('\0')
        files = [name for name in files if name]
    findings = scan(root, files)
    for name, line, rule in findings:
        print(f'{name}:{line}: {rule}')
    print(f'Public-source scan: {len(files)} paths checked, {len(findings)} findings. Values are never printed.')
    return bool(findings)


if __name__ == '__main__':
    sys.exit(main())
