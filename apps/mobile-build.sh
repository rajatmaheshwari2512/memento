# The steps apps/android/build.sh and apps/ios/build.sh share. Sourced by them, after they set
# repo (this repo), src (its immich/) and env_file (the settings file):
#   env_value NAME          NAME's value in the settings file, or nothing
#   save_build_inputs       keeps a copy of the lock files and i18n/ that the build rewrites
#   restore_build_inputs    puts them back (from the build script's EXIT trap)
#   generate_code           Memento's texts, the API client, Flutter packages and generated code;
#                           ends in $src/mobile

# env_value NAME: NAME's value in the settings file, or nothing.
env_value() {
  [ -f "$env_file" ] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "$env_file" | tail -n 1 |
    sed -e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

export MISE_AUTO_INSTALL=false MISE_TASK_RUN_AUTO_INSTALL=false MISE_EXEC_AUTO_INSTALL=false
export MISE_EXPERIMENTAL=1
export MISE_YES=1

save_build_inputs() {
  saved="$(mktemp -d)"
  mkdir -p "$saved/mobile" "$saved/native" "$saved/i18n"
  cp "$src/mise.lock" "$saved/mise.lock"
  cp "$src/mobile/mise.lock" "$saved/mobile/mise.lock"
  cp "$src/native/mise.lock" "$saved/native/mise.lock"
  cp -R "$src/i18n/." "$saved/i18n/"
}

restore_build_inputs() {
  cp "$saved/mise.lock" "$src/mise.lock"
  cp "$saved/mobile/mise.lock" "$src/mobile/mise.lock"
  cp "$saved/native/mise.lock" "$src/native/mise.lock"
  rm -rf "$src/i18n" && mkdir "$src/i18n" && cp -R "$saved/i18n/." "$src/i18n/" && rm -rf "$saved"
}

generate_code() {
  # Memento branding for the UI texts (all languages), only for this build.
  python3 -I "$repo/apps/brand/rebrand-i18n.py" "$src"

  echo "== Generating the API client"
  cd "$src"
  mise run //:open-api-dart

  echo "== Installing Flutter packages"
  cd "$src/mobile"
  mise exec -- flutter pub get --enforce-lockfile
  mise run //mobile:install:build-runner-patch

  echo "== Generating code"
  mise run //mobile:codegen:drift:migration
  mise run //mobile:codegen:dart
  mise run //mobile:codegen:native
  mise run //mobile:codegen:pigeon
  mise run //mobile:i18n:loader
  mise run //mobile:i18n:keys
}
