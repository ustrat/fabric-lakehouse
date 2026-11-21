"""List the Fabric semantic models and SQL endpoints you can see, pick one, get its connection details.

Uses your own sign-in (az login, VS Code, or a browser prompt), so it shows exactly the
workspaces and items your account can access -- the same set Foundry's Fabric IQ picker shows.

    pip install azure-identity requests
    python list_fabric_sources.py                 # interactive pick list
    python list_fabric_sources.py --json          # print everything as JSON, no prompt
    python list_fabric_sources.py --filter retail # only names containing "retail"
"""
import argparse
import json
import sys

import requests
from azure.identity import AzureCliCredential, ChainedTokenCredential, InteractiveBrowserCredential

FABRIC = "https://api.fabric.microsoft.com/v1"


def get_all(session, url, key="value"):
    """GET a Fabric list endpoint, following continuation tokens."""
    items = []
    while url:
        r = session.get(url, timeout=60)
        if r.status_code in (403, 404):  # no rights on this workspace/item type; skip it
            return items
        r.raise_for_status()
        body = r.json()
        items.extend(body.get(key, []))
        url = body.get("continuationUri")
    return items


def collect(session, name_filter):
    sources = []
    for ws in get_all(session, f"{FABRIC}/workspaces"):
        wid, wname = ws["id"], ws["displayName"]

        for m in get_all(session, f"{FABRIC}/workspaces/{wid}/semanticModels"):
            sources.append({
                "kind": "semantic model",
                "name": m["displayName"],
                "workspace": wname,
                "workspaceId": wid,
                "id": m["id"],
                "executeQueriesUrl": f"https://api.powerbi.com/v1.0/myorg/groups/{wid}/datasets/{m['id']}/executeQueries",
                # Personal "My workspace" has no XMLA endpoint; use executeQueries there.
                "xmlaEndpoint": None if ws.get("type") == "Personal"
                else "powerbi://api.powerbi.com/v1.0/myorg/" + requests.utils.quote(wname),
            })

        for lh in get_all(session, f"{FABRIC}/workspaces/{wid}/lakehouses"):
            sql = (lh.get("properties") or {}).get("sqlEndpointProperties") or {}
            if not sql.get("connectionString"):
                continue  # SQL endpoint still provisioning
            sources.append({
                "kind": "lakehouse SQL endpoint",
                "name": lh["displayName"],
                "workspace": wname,
                "workspaceId": wid,
                "id": sql.get("id"),
                "server": sql["connectionString"],
                "database": lh["displayName"],
            })

        for wh in get_all(session, f"{FABRIC}/workspaces/{wid}/warehouses"):
            conn = (wh.get("properties") or {}).get("connectionString")
            if conn:
                sources.append({
                    "kind": "warehouse",
                    "name": wh["displayName"],
                    "workspace": wname,
                    "workspaceId": wid,
                    "id": wh["id"],
                    "server": conn,
                    "database": wh["displayName"],
                })

    if name_filter:
        f = name_filter.lower()
        sources = [s for s in sources if f in s["name"].lower() or f in s["workspace"].lower()]
    return sorted(sources, key=lambda s: (s["kind"], s["workspace"].lower(), s["name"].lower()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", help="print the list as JSON and exit")
    ap.add_argument("--filter", help="only show items whose name or workspace contains this text")
    args = ap.parse_args()

    cred = ChainedTokenCredential(AzureCliCredential(process_timeout=60),InteractiveBrowserCredential())
    token = cred.get_token("https://api.fabric.microsoft.com/.default").token
    session = requests.Session()
    session.headers["Authorization"] = f"Bearer {token}"

    sources = collect(session, args.filter)
    if args.json:
        print(json.dumps(sources, indent=2))
        return
    if not sources:
        sys.exit("No semantic models or SQL endpoints visible to this account.")

    for i, s in enumerate(sources, 1):
        print(f"{i:>3}. [{s['kind']}] {s['name']}  (workspace: {s['workspace']})")
    choice = input("\nPick a number (Enter to quit): ").strip()
    if not choice:
        return
    picked = sources[int(choice) - 1]
    print(json.dumps(picked, indent=2))


if __name__ == "__main__":
    main()
