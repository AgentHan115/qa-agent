#!/usr/bin/env sh
# Downloads the demo document: "GPT-4 Technical Report" (OpenAI), arXiv:2303.08774
# version 3 (27 Mar 2023). The PDF isn't committed: arXiv distributes it under
# its non-exclusive distribution license, which doesn't extend to us.
#
# The version is pinned and the file is checked against a SHA-256 hash, because
# the eval's gold page numbers refer to this exact file. (Copies saved from the
# arXiv submission preview differ only in the page-1 margin stamp,
# "arXiv:submit/4812508" instead of "arXiv:2303.08774v3"; page text is otherwise
# identical, so page numbers match.)
#
#   sh server/scripts/fetch-demo-doc.sh
#
# Env: DEMO_DOC_DEST (default: server/uploads/gpt-4.pdf)
#      ALLOW_CHECKSUM_MISMATCH=1  keep a file whose hash differs (arXiv may
#                                 regenerate PDFs; page numbers may then shift)
set -eu

URL="https://arxiv.org/pdf/2303.08774v3"
SHA256="a4990dde0f0e9e7a28f75ab8442294135a9343da9872eda7fbb9c9297384a0f5"
DEST="${DEMO_DOC_DEST:-$(cd "$(dirname "$0")/.." && pwd)/uploads/gpt-4.pdf}"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

if [ -f "$DEST" ] && [ "$(sha256 "$DEST")" = "$SHA256" ]; then
  echo "Demo document already present and verified: $DEST"
  exit 0
fi

mkdir -p "$(dirname "$DEST")"
echo "Downloading $URL ..."
curl -fL --retry 3 --silent --show-error -o "$DEST.download" "$URL"

ACTUAL="$(sha256 "$DEST.download")"
if [ "$ACTUAL" != "$SHA256" ] && [ "${ALLOW_CHECKSUM_MISMATCH:-0}" != "1" ]; then
  echo "Checksum mismatch for $URL" >&2
  echo "  expected $SHA256" >&2
  echo "  got      $ACTUAL" >&2
  echo "Kept the download at $DEST.download. If arXiv regenerated the PDF, re-run with" >&2
  echo "ALLOW_CHECKSUM_MISMATCH=1 and re-check the eval's gold page numbers." >&2
  exit 1
fi

mv "$DEST.download" "$DEST"
echo "Saved $DEST (sha256 $ACTUAL)"
