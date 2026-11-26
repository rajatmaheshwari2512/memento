// SelfPhotos Adjust: the shared maths for the sliders, filters, straighten and perspective.
// Used by the web (adjust-renderer.ts, WebGL2) and Android (mobile/shaders/selfphotos_adjust.frag).

uniform sampler2D uTexture;   // the source photo, or the part of it this tile needs
uniform vec2 uTexOrigin;      // where uTexture starts in the source, in source pixels
uniform vec2 uTexSize;        // uTexture's size, in source pixels
uniform vec2 uSrcSize;        // the whole source (upright), in pixels
uniform vec2 uOutSize;        // the whole output picture, in pixels
uniform vec2 uTileOrigin;     // where this render starts in the output, in pixels
uniform vec2 uRotation;       // straighten: (cos, sin) of the angle, clockwise
uniform vec2 uCropScale;      // the crop: its width and height, each a share of the source's
uniform vec2 uCropCentre;     // the crop's centre: the source's centre, unless perspective moves it
// Perspective (adjust-geometry.ts): the rows of the matrix from the straightened picture to the source, in pixels (none: 1 0 0, 0 1 0, 0 0 1).
uniform vec3 uPerspectiveX;
uniform vec3 uPerspectiveY;
uniform vec3 uPerspectiveW;
uniform float uPremultiplied; // 1 when uTexture's colours are premultiplied by alpha (Flutter)

uniform float uExposure;      // stops of light: -1..1 is -2..+2 EV
uniform float uBrightness;    // midtones, keeping black and white
uniform float uContrast;
uniform float uHighlights;
uniform float uShadows;
uniform float uSaturation;    // -1 is black and white
uniform float uWarmth;        // + yellow, - blue
uniform float uTint;          // + magenta, - green
uniform float uVignette;      // + darker corners, - lighter corners
uniform float uFade;          // filters only, 0..1: lifts the blacks, softens the whites
uniform vec3 uToneShadows;    // filters only: a colour pushed into the shadows (rgb, -1..1)
uniform vec3 uToneHighlights; // filters only: a colour pushed into the highlights

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}

vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

// An S-curve around middle grey (more contrast), or a pull towards it (less).
vec3 contrastCurve(vec3 v, float amount) {
  if (amount >= 0.0) {
    float k = 1.0 + 1.5 * amount;
    vec3 low = 0.5 * pow(2.0 * v, vec3(k));
    vec3 high = 1.0 - 0.5 * pow(2.0 * (1.0 - v), vec3(k));
    return mix(low, high, step(vec3(0.5), v));
  }
  return mix(v, vec3(0.5), -0.5 * amount);
}

// Shadows lift or deepen the dark tones, highlights the bright ones.
float toneCurve(float l, float shadows, float highlights) {
  float darks = l * (1.0 - l) * (1.0 - l);
  float brights = l * l * (1.0 - l);
  float s = shadows * (shadows > 0.0 ? 1.9 : 0.9);
  float h = highlights * (highlights > 0.0 ? 0.9 : 1.9);
  return l + s * darks + h * brights;
}

// The colour at one point. `pos` is where it is in the whole output picture, 0..1 (vignette).
vec3 adjustColor(vec3 rgb, vec2 pos) {
  vec3 lin = srgbToLinear(rgb) * exp2(uExposure * 2.0);
  vec3 balance = vec3(1.0 + 0.25 * uWarmth + 0.1 * uTint, 1.0 - 0.2 * uTint, 1.0 - 0.25 * uWarmth + 0.1 * uTint);
  lin *= balance / dot(balance, LUMA);
  vec3 v = linearToSrgb(clamp(lin, 0.0, 1.0));

  v = pow(v, vec3(exp2(-0.75 * uBrightness)));
  v = contrastCurve(v, uContrast);

  float l = dot(v, LUMA);
  float toned = clamp(toneCurve(l, uShadows, uHighlights), 0.0, 1.0);
  v = l > 0.0001 ? v * (toned / l) : vec3(toned);
  float top = max(v.r, max(v.g, v.b));
  if (top > 1.0) {
    v = toned + (v - toned) * ((1.0 - toned) / (top - toned));
  }

  l = dot(v, LUMA);
  v = mix(vec3(l), v, 1.0 + uSaturation);

  v = mix(v, vec3(0.08) + 0.86 * v, uFade);
  l = dot(v, LUMA);
  v += 0.4 * (uToneShadows * (1.0 - l) * (1.0 - l) + uToneHighlights * l * l);

  float r = length((pos - 0.5) * 2.0) * 0.70710678;
  float edge = smoothstep(0.35, 1.0, r);
  v = uVignette >= 0.0 ? v * (1.0 - 0.65 * uVignette * edge) : mix(v, vec3(1.0), -0.6 * uVignette * edge);

  return clamp(v, 0.0, 1.0);
}

// The source position (in source pixels) shown at an output position (in output pixels).
vec2 sourcePosition(vec2 outPos) {
  vec2 q = (outPos / uOutSize - 0.5) * uSrcSize * uCropScale;
  vec2 turned = vec2(q.x * uRotation.x + q.y * uRotation.y, q.y * uRotation.x - q.x * uRotation.y);
  vec3 p = vec3(uCropCentre + turned, 1.0);
  return vec2(dot(uPerspectiveX, p), dot(uPerspectiveY, p)) / dot(uPerspectiveW, p);
}

// One output pixel. `tilePos` is its centre in this render, in pixels.
vec4 adjustPixel(vec2 tilePos) {
  vec2 outPos = uTileOrigin + tilePos;
  vec2 uv = (sourcePosition(outPos) - uTexOrigin) / uTexSize;
  vec2 halfTexel = 0.5 / uTexSize;
  vec4 c = texture(uTexture, clamp(uv, halfTexel, 1.0 - halfTexel));
  vec3 rgb = c.rgb;
  if (uPremultiplied > 0.5) {
    rgb = c.a > 0.0 ? rgb / c.a : vec3(0.0);
  }
  rgb = adjustColor(clamp(rgb, 0.0, 1.0), outPos / uOutSize);
  return uPremultiplied > 0.5 ? vec4(rgb * c.a, c.a) : vec4(rgb, c.a);
}
