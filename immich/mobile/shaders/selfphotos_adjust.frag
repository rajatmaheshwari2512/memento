// SelfPhotos Adjust for Android: Flutter's wrapper around adjust-core.glsl (the maths the web uses too).
// After any change to adjust-core.glsl, put its new hash in the line below (shasum -a 256 on the file).
// adjust-core.glsl sha256: 7852f190c3c9a03693e85743ae46aef2958aeab457fb1fe43119f387430b8170
#version 460 core

#include <flutter/runtime_effect.glsl>

precision highp float;

#include "../../web/src/lib/ai-edit/adjust/adjust-core.glsl"

out vec4 fragColor;

void main() {
  fragColor = adjustPixel(FlutterFragCoord().xy);
}
