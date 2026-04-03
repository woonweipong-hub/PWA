import json, urllib.request, sys

BASE = "https://api.siteshrimp.org"
EMAIL = "woonwei.pong@gmail.com"
PASS = "YourPasswordHere123"

def api(method, path, data=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(f"{BASE}{path}", data=body, headers=headers, method=method)
    resp = urllib.request.urlopen(req, timeout=15)
    return json.loads(resp.read())

# 1. Authenticate
print("=== Authenticating ===")
auth = api("POST", "/api/collections/_superusers/auth-with-password", {"identity": EMAIL, "password": PASS})
token = auth["token"]
print("  OK")

# 2. Get defects collection
print("\n=== Getting defects collection ===")
coll = api("GET", "/api/collections/defects", token=token)
coll_id = coll["id"]
schema_key = "fields" if "fields" in coll else "schema"
existing = {f["name"] for f in coll.get(schema_key, [])}
schema = list(coll.get(schema_key, []))
print(f"  Collection ID: {coll_id}")
print(f"  Existing fields ({len(existing)}): {', '.join(sorted(existing))}")

# 3. Define all missing fields
new_fields = [
    {"name":"entryType","type":"text","required":True},
    {"name":"component","type":"text"},
    {"name":"trade","type":"text"},
    {"name":"locationLevel","type":"text"},
    {"name":"locationZone","type":"text"},
    {"name":"locationSubzone","type":"text"},
    {"name":"locationGrid","type":"text"},
    {"name":"locationDisplay","type":"text"},
    {"name":"assigneeId","type":"text"},
    {"name":"dueDate","type":"text"},
    {"name":"duration","type":"text"},
    {"name":"actualCompleted","type":"text"},
    {"name":"costImpact","type":"text"},
    {"name":"costAmount","type":"text"},
    {"name":"costResponsible","type":"text"},
    {"name":"costRemarks","type":"text","options":{"max":2000}},
    {"name":"closedAt","type":"text"},
    {"name":"verifiedAt","type":"text"},
    {"name":"verifiedBy","type":"text"},
    {"name":"drawingPinId","type":"text"},
    {"name":"defect_id","type":"text"},
    {"name":"unit","type":"text"},
    {"name":"category","type":"text"},
    {"name":"defect_type","type":"text"},
    {"name":"telegram_user","type":"text"},
    {"name":"transcript_text","type":"text","options":{"max":5000}},
    {"name":"voice_file_id","type":"text"},
    {"name":"photo_file_id","type":"text"},
    {"name":"photo_url","type":"text","options":{"max":2000}},
    {"name":"initiated_by","type":"text"},
    {"name":"responsible_party","type":"text"},
    {"name":"follow_up_by","type":"text"},
    {"name":"remarks","type":"text"},
    {"name":"cost","type":"text"},
    {"name":"quality","type":"text"},
    {"name":"target_fix_date","type":"text"},
    {"name":"resolved_date","type":"text"},
    {"name":"input_source","type":"text"},
    {"name":"timestamp_utc","type":"text"},
    {"name":"photoOriginal","type":"file","options":{"maxSelect":5,"maxSize":10485760,"mimeTypes":["image/jpeg","image/png","image/webp"]}},
    {"name":"costDoc","type":"file","options":{"maxSelect":3,"maxSize":10485760,"mimeTypes":["application/pdf","image/jpeg","image/png","image/webp"]}},
]

# 4. Add missing fields
print("\n=== Adding missing fields ===")
added = 0
for f in new_fields:
    if f["name"] not in existing:
        schema.append(f)
        added += 1
        print(f'  + {f["name"]} ({f["type"]})')
    else:
        print(f'  . {f["name"]} (already exists)')

if added == 0:
    print("  No new fields needed!")
else:
    print(f"\n  Updating collection with {added} new fields...")
    result = api("PATCH", f"/api/collections/{coll_id}", {schema_key: schema}, token=token)
    count = len(result.get(schema_key, []))
    print(f"  SUCCESS! defects now has {count} fields")

# 5. Fix deleteRule on collections
print("\n=== Fixing deleteRule ===")
for name in ["companies", "projects", "invites", "settings"]:
    try:
        c = api("GET", f"/api/collections/{name}", token=token)
        if c.get("deleteRule"):
            print(f"  {name}: already has deleteRule")
            continue
        api("PATCH", f"/api/collections/{c['id']}", {"deleteRule": "@request.auth.id != ''"}, token=token)
        print(f"  {name}: FIXED")
    except Exception as e:
        print(f"  {name}: FAILED ({e})")

# 6. Create activity collection if missing
print("\n=== Checking activity collection ===")
try:
    api("GET", "/api/collections/activity", token=token)
    print("  activity: exists")
except:
    print("  activity: NOT FOUND - creating...")
    try:
        api("POST", "/api/collections", {
            "name": "activity",
            "type": "base",
            "fields": [
                {"name":"entryId","type":"text","required":True},
                {"name":"companyId","type":"text","required":True},
                {"name":"type","type":"text","required":True},
                {"name":"action","type":"text"},
                {"name":"oldValue","type":"text"},
                {"name":"newValue","type":"text"},
                {"name":"comment","type":"text","options":{"max":5000}},
                {"name":"userId","type":"text"},
                {"name":"userName","type":"text"},
                {"name":"userRole","type":"text"},
                {"name":"photo","type":"file","options":{"maxSelect":1,"maxSize":10485760,"mimeTypes":["image/jpeg","image/png","image/webp"]}},
                {"name":"timestamp","type":"text"},
            ],
            "listRule": "@request.auth.id != ''",
            "viewRule": "@request.auth.id != ''",
            "createRule": "@request.auth.id != ''",
            "updateRule": "@request.auth.id != ''",
            "deleteRule": "@request.auth.id != ''",
        }, token=token)
        print("  activity: CREATED")
    except Exception as e:
        body = e.read().decode() if hasattr(e, "read") else str(e)
        print(f"  activity: FAILED ({body})")

# 7. Create counters collection if missing
print("\n=== Checking counters collection ===")
try:
    api("GET", "/api/collections/counters", token=token)
    print("  counters: exists")
except:
    print("  counters: NOT FOUND - creating...")
    try:
        api("POST", "/api/collections", {
            "name": "counters",
            "type": "base",
            "fields": [
                {"name":"key","type":"text","required":True},
                {"name":"value","type":"number","required":True},
            ],
            "listRule": "@request.auth.id != ''",
            "viewRule": "@request.auth.id != ''",
            "createRule": "@request.auth.id != ''",
            "updateRule": "@request.auth.id != ''",
            "deleteRule": "@request.auth.id != ''",
        }, token=token)
        print("  counters: CREATED")
    except Exception as e:
        body = e.read().decode() if hasattr(e, "read") else str(e)
        print(f"  counters: FAILED ({body})")

# 8. Create drawings collection if missing
print("\n=== Checking drawings collection ===")
try:
    api("GET", "/api/collections/drawings", token=token)
    print("  drawings: exists")
except:
    print("  drawings: NOT FOUND - creating...")
    try:
        api("POST", "/api/collections", {
            "name": "drawings",
            "type": "base",
            "fields": [
                {"name":"companyId","type":"text","required":True},
                {"name":"projectId","type":"text","required":True},
                {"name":"name","type":"text","required":True},
                {"name":"file","type":"file","required":True,"options":{"maxSelect":1,"maxSize":52428800,"mimeTypes":["application/pdf","image/jpeg","image/png","image/webp"]}},
                {"name":"pageCount","type":"number"},
                {"name":"uploadedBy","type":"text"},
                {"name":"uploadedAt","type":"text"},
            ],
            "listRule": "@request.auth.id != ''",
            "viewRule": "@request.auth.id != ''",
            "createRule": "@request.auth.id != ''",
            "updateRule": "@request.auth.id != ''",
            "deleteRule": "@request.auth.id != ''",
        }, token=token)
        print("  drawings: CREATED")
    except Exception as e:
        body = e.read().decode() if hasattr(e, "read") else str(e)
        print(f"  drawings: FAILED ({body})")

# 9. Create pins collection if missing
print("\n=== Checking pins collection ===")
try:
    api("GET", "/api/collections/pins", token=token)
    print("  pins: exists")
except:
    print("  pins: NOT FOUND - creating...")
    try:
        api("POST", "/api/collections", {
            "name": "pins",
            "type": "base",
            "fields": [
                {"name":"drawingId","type":"text","required":True},
                {"name":"entryId","type":"text","required":True},
                {"name":"pageNum","type":"number","required":True},
                {"name":"x","type":"number","required":True},
                {"name":"y","type":"number","required":True},
                {"name":"label","type":"text"},
            ],
            "listRule": "@request.auth.id != ''",
            "viewRule": "@request.auth.id != ''",
            "createRule": "@request.auth.id != ''",
            "updateRule": "@request.auth.id != ''",
            "deleteRule": "@request.auth.id != ''",
        }, token=token)
        print("  pins: CREATED")
    except Exception as e:
        body = e.read().decode() if hasattr(e, "read") else str(e)
        print(f"  pins: FAILED ({body})")

print("\n=== ALL DONE ===")
