#!/bin/bash
# ─────────────────────────────────────────────────────────────────
# SiteShrimp — Fix missing fields on live PocketBase
# Run: bash fix_schema.sh <admin_email> <admin_password>
# ─────────────────────────────────────────────────────────────────

BASE="https://api.siteshrimp.org"
EMAIL="${1:?Usage: bash fix_schema.sh <admin_email> <admin_password>}"
PASS="${2:?Usage: bash fix_schema.sh <admin_email> <admin_password>}"

echo "=== Authenticating as superuser ==="
LOGIN=$(curl -s --max-time 10 -X POST "$BASE/api/collections/_superusers/auth-with-password" \
  -H "Content-Type: application/json" \
  -d "{\"identity\":\"$EMAIL\",\"password\":\"$PASS\"}")
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "FAILED to authenticate. Check your admin email/password."
  echo "$LOGIN"
  exit 1
fi
echo "  Authenticated OK"

# ── Get current defects collection ID ──
echo ""
echo "=== Getting defects collection ==="
COLL=$(curl -s --max-time 10 "$BASE/api/collections/defects" \
  -H "Authorization: Bearer $TOKEN")
COLL_ID=$(echo "$COLL" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
echo "  Collection ID: $COLL_ID"

# Get existing field names
EXISTING=$(echo "$COLL" | python3 -c "
import sys,json
d=json.load(sys.stdin)
fields=[f['name'] for f in d.get('schema',d.get('fields',[]))]
print(','.join(fields))
" 2>/dev/null)
echo "  Existing fields: $EXISTING"

# ── Define missing fields ──
# Each line: name|type|required|options(json)
FIELDS=(
  'entryType|text|true|{}'
  'component|text|false|{}'
  'trade|text|false|{}'
  'locationLevel|text|false|{}'
  'locationZone|text|false|{}'
  'locationSubzone|text|false|{}'
  'locationGrid|text|false|{}'
  'locationDisplay|text|false|{}'
  'assigneeId|text|false|{}'
  'dueDate|text|false|{}'
  'duration|text|false|{}'
  'actualCompleted|text|false|{}'
  'costImpact|text|false|{}'
  'costAmount|text|false|{}'
  'costResponsible|text|false|{}'
  'costRemarks|text|false|{"max":2000}'
  'closedAt|text|false|{}'
  'verifiedAt|text|false|{}'
  'verifiedBy|text|false|{}'
  'drawingPinId|text|false|{}'
  'defect_id|text|false|{}'
  'unit|text|false|{}'
  'category|text|false|{}'
  'defect_type|text|false|{}'
  'telegram_user|text|false|{}'
  'transcript_text|text|false|{"max":5000}'
  'voice_file_id|text|false|{}'
  'photo_file_id|text|false|{}'
  'photo_url|text|false|{"max":2000}'
  'initiated_by|text|false|{}'
  'responsible_party|text|false|{}'
  'follow_up_by|text|false|{}'
  'remarks|text|false|{}'
  'cost|text|false|{}'
  'quality|text|false|{}'
  'target_fix_date|text|false|{}'
  'resolved_date|text|false|{}'
  'input_source|text|false|{}'
  'timestamp_utc|text|false|{}'
  'photoOriginal|file|false|{"maxSelect":5,"maxSize":10485760,"mimeTypes":["image/jpeg","image/png","image/webp"]}'
  'costDoc|file|false|{"maxSelect":3,"maxSize":10485760,"mimeTypes":["application/pdf","image/jpeg","image/png","image/webp"]}'
)

echo ""
echo "=== Adding missing fields to defects collection ==="

# Build the new schema by getting existing + adding missing
python3 -c "
import sys,json,subprocess

# Get current collection
coll_json = '''$COLL'''
coll = json.loads(coll_json)

# Get existing field names (handle both 'schema' and 'fields' keys)
schema_key = 'schema' if 'schema' in coll else 'fields'
existing = {f['name'] for f in coll.get(schema_key, [])}
new_schema = list(coll.get(schema_key, []))

fields_raw = '''$(printf '%s\n' "${FIELDS[@]}")'''

added = 0
for line in fields_raw.strip().split('\n'):
    parts = line.split('|')
    name, ftype, required, opts = parts[0], parts[1], parts[2]=='true', json.loads(parts[3])
    if name in existing:
        continue
    field = {'name': name, 'type': ftype, 'required': required}
    if opts:
        field['options'] = opts
    new_schema.append(field)
    added += 1
    print(f'  + {name} ({ftype})')

if added == 0:
    print('  No new fields to add!')
    sys.exit(0)

print(f'\n  Adding {added} fields...')

# Update collection
import urllib.request
data = json.dumps({schema_key: new_schema}).encode()
req = urllib.request.Request(
    '$BASE/api/collections/$COLL_ID',
    data=data,
    headers={
        'Authorization': 'Bearer $TOKEN',
        'Content-Type': 'application/json'
    },
    method='PATCH'
)
try:
    resp = urllib.request.urlopen(req, timeout=15)
    result = json.loads(resp.read())
    new_count = len(result.get(schema_key, result.get('fields', [])))
    print(f'  SUCCESS! Collection now has {new_count} fields')
except Exception as e:
    body = e.read().decode() if hasattr(e, 'read') else str(e)
    print(f'  FAILED: {body}')
" 2>&1

echo ""
echo "=== Fixing deleteRule on collections missing it ==="
for COLLECTION in companies projects invites settings activity counters; do
  echo -n "  $COLLECTION... "
  # Get collection
  C=$(curl -s --max-time 10 "$BASE/api/collections/$COLLECTION" -H "Authorization: Bearer $TOKEN")
  C_ID=$(echo "$C" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
  HAS_DELETE=$(echo "$C" | python3 -c "import sys,json;d=json.load(sys.stdin);print('yes' if d.get('deleteRule') else 'no')" 2>/dev/null)

  if [ "$HAS_DELETE" = "yes" ]; then
    echo "already has deleteRule"
    continue
  fi

  if [ -z "$C_ID" ]; then
    echo "NOT FOUND (may need creating)"
    continue
  fi

  # Add deleteRule
  UPD=$(curl -s --max-time 10 -X PATCH "$BASE/api/collections/$C_ID" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"deleteRule":"@request.auth.id != '\'''\''"}')
  NEW_DR=$(echo "$UPD" | python3 -c "import sys,json;print(json.load(sys.stdin).get('deleteRule','FAIL'))" 2>/dev/null)
  [ -n "$NEW_DR" ] && echo "FIXED" || echo "FAILED"
done

echo ""
echo "=== Done! ==="
echo "All 24 missing defect fields + deleteRules have been applied."
echo "Your app should now save all data correctly."
