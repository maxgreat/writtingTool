#!/bin/bash
# Usage: play-upload.sh <bundle.aab> <version code> <track> <release name>
# Uploads a signed App Bundle to Google Play and makes it the release of a
# track, through the Google Play Developer API. Needs PLAY_TOKEN, an access
# token for the androidpublisher scope, and PACKAGE, the app's identifier.
# A re-run finds its bundle already in Play and only sets the track again.
set -euo pipefail
shopt -s inherit_errexit

bundle=$1
version=$2
track=$3
name=$4
# PLAY_API_ROOT is only set by tests, to point at a stand-in server.
root=${PLAY_API_ROOT:-https://androidpublisher.googleapis.com}
api="$root/androidpublisher/v3/applications/$PACKAGE"
upload_api="$root/upload/androidpublisher/v3/applications/$PACKAGE"

# call <method> <url> [curl options...]: prints the response body, or
# fails with Google's error message.
call() {
  local method=$1 url=$2
  shift 2
  local body status
  body=$(mktemp)
  status=$(curl -sS -o "$body" -w '%{http_code}' -X "$method" \
    -H "Authorization: Bearer $PLAY_TOKEN" "$@" "$url")
  if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
    echo "::error::Google Play answered $status to $method ${url#"$root"}: $(jq -r '.error.message // .' "$body" 2> /dev/null || cat "$body")" >&2
    rm -f "$body"
    return 1
  fi
  cat "$body"
  rm -f "$body"
}

# Changes to an app are made in an edit, which takes effect on commit.
# Requests without a body still send one ({} or an empty one), as Google
# refuses a POST with no Content-Length.
edit=$(call POST "$api/edits" -H 'Content-Type: application/json' -d '{}' | jq -r .id)

# Re-running an older run's job after a newer build is on the track leaves
# the track alone, as the publish job does for the GitHub release.
newest=$(call GET "$api/edits/$edit/tracks/$track" |
  jq '[.releases[]?.versionCodes[]? | tonumber] | max // 0')
if [ "$newest" -gt "$version" ]; then
  echo "::notice::The $track track already has version code $newest, newer than $version, so it is left as it is."
  exit 0
fi

have=$(call GET "$api/edits/$edit/bundles" |
  jq --argjson v "$version" '[.bundles[]?.versionCode] | index($v) != null')
if [ "$have" = true ]; then
  echo "Google Play already has version code $version, so it isn't uploaded again."
else
  uploaded=$(call POST "$upload_api/edits/$edit/bundles?uploadType=media" \
    -H 'Content-Type: application/octet-stream' --data-binary "@$bundle" | jq -r .versionCode)
  if [ "$uploaded" != "$version" ]; then
    echo "::error::Google Play read version code $uploaded in the bundle instead of $version." >&2
    exit 1
  fi
  echo "Uploaded version code $version."
fi

release=$(jq -n --arg name "$name" --arg version "$version" \
  '{releases: [{name: $name, versionCodes: [$version], status: "completed"}]}')
call PUT "$api/edits/$edit/tracks/$track" -H 'Content-Type: application/json' -d "$release" > /dev/null
call POST "$api/edits/$edit:commit" -H 'Content-Length: 0' > /dev/null
echo "Version code $version is now the $track release, named \"$name\"."
