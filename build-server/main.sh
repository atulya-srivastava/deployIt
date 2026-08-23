#!/bin/bash

export GIT_REPOSITORY__URL="$GIT_REPOSITORY__URL"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
OUTPUT_DIR="${SCRIPT_DIR}/output"

rm -rf "$OUTPUT_DIR"
git clone "$GIT_REPOSITORY__URL" "$OUTPUT_DIR"

exec node "${SCRIPT_DIR}/script.js"