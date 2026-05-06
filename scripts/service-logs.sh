#!/usr/bin/env bash
set -euo pipefail

journalctl -u cafescanner -f
