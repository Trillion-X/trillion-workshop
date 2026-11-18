#!/bin/sh
# tools/use-your-tools-from-a-shell/do-work/install.sh
#
# Purpose
#   The install line a site gives: `curl -fsSL {origin}/cli/install | sh`. It puts the site's command ({cli}) on this
#   computer from the site that served it and writes that site, its site and its command to the site file (command.json
#   `site_file`), so the person then types only `{cli} login`. write-site-pages.mjs fills {origin}, {site_name}, {cli} and {program} from
#   the serving site's own origin and site row and this tool's settings; this file names no product.
#
# Non-negotiable invariants
#   1. Every file comes from {origin}/cli/program/ over https, named by its files.txt; a file that does not arrive stops the
#      install with nothing half-written: the new program replaces the old one in one rename.
#   2. No address, setting or flag is asked of the person. The link goes where this command's link already is, else in
#      ~/.local/bin, never in another program's folder; ~/.local/bin is added to the shell's own start file when it is not on
#      PATH, and the person is told to open a new terminal.
#   3. A file at the link that this install did not make is never overwritten.
#   4. Needs only sh, curl and Node.js 22 or newer; without Node.js it says where to get it and changes nothing.
#   5. A command word is one site's on a computer: two sites whose sites chose the same word would share its link on PATH
#      and its state folder, so an install from another site than the one this command came from changes nothing and
#      says so.
set -eu

origin='{origin}'
site_name='{site_name}'
cli='{cli}'
program_file='{program}'
home_state="$HOME/.$cli/cli"
program="$home_state/program"

if [ -f "$home_state/site.json" ]; then
  installed_from=$(sed -n 's/^ *"origin": *"\([^"]*\)".*/\1/p' "$home_state/site.json" | head -n 1)
  if [ -n "$installed_from" ] && [ "$installed_from" != "$origin" ]; then
    echo "$cli on this computer is already the command of $installed_from, and this install is from $origin. Nothing was changed."
    exit 1
  fi
fi

major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$major" -lt 22 ]; then
  echo "$site_name needs Node.js 22 or newer on this computer. Get it from https://nodejs.org, then run the install line again."
  exit 1
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/$cli-install.XXXXXX")
trap 'rm -rf "$work"' EXIT
curl -fsSL "$origin/cli/program/files.txt" -o "$work/files.txt"
while IFS= read -r name; do
  [ -n "$name" ] || continue
  mkdir -p "$work/program/$(dirname "$name")"
  curl -fsSL "$origin/cli/program/$name" -o "$work/program/$name"
done < "$work/files.txt"
chmod 755 "$work/program/$program_file"

mkdir -p "$home_state"
chmod 700 "$home_state"
if [ -d "$program" ]; then mv "$program" "$work/old-program"; fi
mv "$work/program" "$program"
printf '{\n  "origin": "%s",\n  "site_name": "%s",\n  "cli": "%s"\n}\n' "$origin" "$site_name" "$cli" > "$home_state/site.json.new"
chmod 600 "$home_state/site.json.new"
mv "$home_state/site.json.new" "$home_state/site.json"

# The link: where this command's link already is on PATH, else ~/.local/bin (never another program's folder).
bin=""
old_ifs=$IFS; IFS=:
for folder in $PATH; do
  if [ -L "$folder/$cli" ] && [ "$(readlink "$folder/$cli")" = "$program/$program_file" ]; then bin=$folder; break; fi
done
IFS=$old_ifs
new_terminal=""
on_path() { case ":$PATH:" in *":$1:"*) return 0 ;; esac; return 1; }
if [ -z "$bin" ]; then
  bin="$HOME/.local/bin"
  mkdir -p "$bin"
fi
if ! on_path "$bin"; then
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
link="$bin/$cli"
if [ -e "$link" ] && [ ! -L "$link" ]; then
  echo "$site_name was installed, but $link is a file this install did not make, so it was left as it is."
  exit 1
fi
ln -sf "$program/$program_file" "$link"

if [ -n "$new_terminal" ]; then
  echo "$site_name is installed. Open a new terminal, then type: $cli login"
else
  echo "$site_name is installed. Now type: $cli login"
fi
