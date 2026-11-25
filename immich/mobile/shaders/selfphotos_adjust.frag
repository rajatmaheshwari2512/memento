// SelfPhotos Adjust for Android: Flutter's wrapper around the maths the web app uses too
// (web/src/lib/ai-edit/adjust/adjust-core.glsl, included as it is). Not part of Immich.
// Used by mobile/lib/selfphotos/adjust/ for the live preview and the full-size tiles.
//
// Flutter's build doesn't notice a change in the included file alone, and would ship the old
// shader. So this file names that file's SHA-256 below: after any change to adjust-core.glsl,
// test/selfphotos/adjust_test.dart fails until the line is updated (shasum -a 256 on the file),
// and changing this file is what makes Flutter rebuild the shader.
// adjust-core.glsl sha256: ed12918c9199fce33f5cdb52a4dc287976f920adc097a4a37d31046fc8881de2
#version 460 core

#include <flutter/runtime_effect.glsl>

precision highp float;

#include "../../web/src/lib/ai-edit/adjust/adjust-core.glsl"

out vec4 fragColor;

void main() {
  fragColor = adjustPixel(FlutterFragCoord().xy);
}
