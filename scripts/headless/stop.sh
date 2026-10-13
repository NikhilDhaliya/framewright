#!/bin/bash
# usage: stop.sh <cdpPort>
# Kills only the Electron process (its command line starts with the binary): xvfb-run then stops its Xvfb.
# Matching xvfb-run too (its arguments contain the same flag) would orphan the Xvfb server.
pkill -f "^[^ ]*electron[^ ]* .*remote-debugging-port=$1( |$)" ; true
