#!/bin/sh
# tools/use-trillion-from-a-shell/do-work/install.sh
#
# Purpose
#   The install line a site gives: `curl -fsSL {origin}/cli/install | sh`. It puts the `trillion` command on this computer
#   from the site that served it and writes that site as the one `trillion login` signs in to (trillion.json `site_file`),
#   so the person then types only `trillion login`. write-site-pages.mjs fills {origin} with the serving site's own origin.
#
# Non-negotiable invariants
#   1. Every file comes from {origin}/cli/program/ over https, named by its files.txt; a file that does not arrive stops the
#      install with nothing half-written: the new program replaces the old one in one rename.
#   2. No address, setting or flag is asked of the person. The link goes in a folder already on PATH that this user may
#      write; with none, ~/.local/bin is used and added to the shell's own start file, and the person is told to open a new
#      terminal.
#   3. A file at the link that this install did not make is never overwritten.
#   4. Needs only sh, curl and Node.js 22 or newer; without Node.js it says where to get it and changes nothing.
set -eu

origin='{origin}'
home_state="$HOME/.trillion/cli"
program="$home_state/program"

major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$major" -lt 22 ]; then
  echo "Trillion needs Node.js 22 or newer on this computer. Get it from https://nodejs.org, then run the install line again."
  exit 1
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/trillion-install.XXXXXX")
trap 'rm -rf "$work"' EXIT
curl -fsSL "$origin/cli/program/files.txt" -o "$work/files.txt"
while IFS= read -r name; do
  [ -n "$name" ] || continue
  mkdir -p "$work/program/$(dirname "$name")"
  curl -fsSL "$origin/cli/program/$name" -o "$work/program/$name"
done < "$work/files.txt"
chmod 755 "$work/program/trillion.mjs"

mkdir -p "$home_state"
chmod 700 "$home_state"
if [ -d "$program" ]; then mv "$program" "$work/old-program"; fi
mv "$work/program" "$program"
printf '{\n  "origin": "%s"\n}\n' "$origin" > "$home_state/site.json.new"
chmod 600 "$home_state/site.json.new"
mv "$home_state/site.json.new" "$home_state/site.json"

# The link: the first folder on PATH under this user's home that it may write, else ~/.local/bin.
bin=""
old_ifs=$IFS; IFS=:
for folder in $PATH; do
  case "$folder" in "$HOME"/*) if [ -d "$folder" ] && [ -w "$folder" ]; then bin=$folder; break; fi ;; esac
done
IFS=$old_ifs
new_terminal=""
if [ -z "$bin" ]; then
  bin="$HOME/.local/bin"
  mkdir -p "$bin"
  case "$(basename "${SHELL:-sh}")" in
    zsh) start="$HOME/.zshrc" ;;
    bash) start="$HOME/.bashrc" ;;
    fish) start="$HOME/.config/fish/config.fish" ;;
    *) start="$HOME/.profile" ;;
  esac
  mkdir -p "$(dirname "$start")"
  if ! grep -qs '.local/bin' "$start"; then
    case "$start" in
      *.fish) printf '\nfish_add_path %s\n' "$bin" >> "$start" ;;
      *) printf '\nexport PATH="%s:$PATH"\n' "$bin" >> "$start" ;;
    esac
  fi
  new_terminal=yes
fi
link="$bin/trillion"
if [ -e "$link" ] && [ ! -L "$link" ]; then
  echo "Trillion was installed, but $link is a file this install did not make, so it was left as it is."
  exit 1
fi
ln -sf "$program/trillion.mjs" "$link"

if [ -n "$new_terminal" ]; then
  echo "Trillion is installed. Open a new terminal, then type: trillion login"
else
  echo "Trillion is installed. Now type: trillion login"
fi
