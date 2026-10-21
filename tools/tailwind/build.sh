#!/bin/sh
# Rebuild assets/tailwind.css after editing any page or assets/lab-tailwind.js.
set -e
cd "$(dirname "$0")"
npx --yes tailwindcss@3.4.17 -c tailwind.config.js -i input.css -o ../../assets/tailwind.css --minify
