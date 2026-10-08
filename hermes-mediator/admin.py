"""Operator CLI for the Hermes mediator ledger.

  python3 admin.py --db PATH create-tenant NAME CREDIT_MICRO
  python3 admin.py --db PATH add-credit NAME AMOUNT_MICRO
  python3 admin.py --db PATH balance NAME
  python3 admin.py --db PATH disable NAME | enable NAME
  python3 admin.py --db PATH list

A tenant token is printed once by create-tenant and never stored; only its
SHA-256 is kept. Amounts are integer micro-USD (1 USD = 1000000).
"""
import argparse
import hashlib
import secrets
import sys
import time

from ledger import Ledger


def main(argv):
    parser = argparse.ArgumentParser(description="Hermes mediator ledger admin")
    parser.add_argument("--db", required=True, help="path to the SQLite ledger")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("create-tenant")
    p.add_argument("name")
    p.add_argument("credit", type=int)

    p = sub.add_parser("add-credit")
    p.add_argument("name")
    p.add_argument("amount", type=int)

    p = sub.add_parser("balance")
    p.add_argument("name")

    p = sub.add_parser("disable")
    p.add_argument("name")

    p = sub.add_parser("enable")
    p.add_argument("name")

    sub.add_parser("list")

    args = parser.parse_args(argv)
    ledger = Ledger(args.db)

    try:
        if args.cmd == "create-tenant":
            if args.credit < 0:
                raise SystemExit("initial credit must not be negative")
            token = secrets.token_urlsafe(32)
            digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
            ledger.create_tenant(args.name, digest, args.credit, int(time.time()))
            print("tenant: %s" % args.name)
            print("token (shown once, store it in the tenant's config only): %s" % token)
        elif args.cmd == "add-credit":
            print("balance_micro: %d" % ledger.add_credit(args.name, args.amount))
        elif args.cmd == "balance":
            print("balance_micro: %d" % ledger.balance(args.name))
        elif args.cmd == "disable":
            ledger.set_enabled(args.name, False)
            print("disabled: %s" % args.name)
        elif args.cmd == "enable":
            ledger.set_enabled(args.name, True)
            print("enabled: %s" % args.name)
        elif args.cmd == "list":
            for tenant_id, balance, enabled in ledger.list_tenants():
                print("%s\tbalance_micro=%d\tenabled=%s" % (tenant_id, balance, bool(enabled)))
    except KeyError as exc:
        print("unknown tenant: %s" % exc.args[0], file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
