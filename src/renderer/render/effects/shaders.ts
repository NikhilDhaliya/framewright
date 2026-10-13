/** GLSL ES 3.00 sources (spec 04 §5–§8). Working images are straight alpha, row 0 = top. */

export const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;

uniform sampler2D uSrc;
uniform vec2 uExtent;
out vec4 fragColor;

const vec3 LUMA709 = vec3(0.2126, 0.7152, 0.0722);

vec4 src() { return texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); }
vec4 srcClamped(ivec2 p) { return texelFetch(uSrc, clamp(p, ivec2(0), ivec2(uExtent) - 1), 0); }
vec4 bilinearClamped(vec2 x) {
  x -= 0.5; ivec2 i = ivec2(floor(x)); vec2 f = x - floor(x);
  return mix(mix(srcClamped(i), srcClamped(i + ivec2(1, 0)), f.x),
             mix(srcClamped(i + ivec2(0, 1)), srcClamped(i + ivec2(1, 1)), f.x), f.y);
}
float sstep(float e0, float e1, float x) { float t = clamp((x - e0) / max(e1 - e0, 1e-6), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
vec4 lut1D(sampler2D t, float v) {
  float x = clamp(v * 256.0 - 0.5, 0.0, 255.0);
  int i0 = int(floor(x)); int i1 = min(i0 + 1, 255);
  return mix(texelFetch(t, ivec2(i0, 0), 0), texelFetch(t, ivec2(i1, 0), 0), x - float(i0));
}
`

const fx = (body: string) => HEADER + body

export const PREMULTIPLY = fx(`void main() { vec4 s = src(); fragColor = vec4(s.rgb * s.a, s.a); }`)

export const UNPREMULTIPLY = fx(`void main() { vec4 s = src(); fragColor = s.a > 0.0 ? vec4(s.rgb / s.a, s.a) : vec4(0.0); }`)

export const GAUSSIAN_1D = fx(`
uniform vec2 uDir;
uniform float uSigma;
uniform int uRadius;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (uSigma < 0.01) { fragColor = texelFetch(uSrc, p, 0); return; }
  float k = 1.0 / (2.0 * uSigma * uSigma);
  vec4 acc = texelFetch(uSrc, p, 0); float wsum = 1.0;
  for (int i = 1; i <= uRadius; ++i) {
    float w = exp(-float(i * i) * k);
    ivec2 d = ivec2(uDir) * i;
    acc += w * (srcClamped(p + d) + srcClamped(p - d));
    wsum += 2.0 * w;
  }
  fragColor = acc / wsum;
}`)

/** Box downsample by an integer factor (large-σ blur path, §8.3). */
export const DOWNSAMPLE = fx(`
uniform int uFactor;
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * uFactor;
  vec4 acc = vec4(0.0);
  for (int j = 0; j < uFactor; ++j) for (int i = 0; i < uFactor; ++i) acc += srcClamped(base + ivec2(i, j));
  fragColor = acc / float(uFactor * uFactor);
}`)

/** Bilinear upsample of a reduced image back to the working extent. */
export const UPSAMPLE = `#version 300 es
precision highp float;
uniform sampler2D uSmall;
uniform vec2 uSmallSize;
uniform float uFactor;
out vec4 fragColor;
void main() {
  vec2 uv = (gl_FragCoord.xy / uFactor) / uSmallSize;
  fragColor = texture(uSmall, uv);
}`

export const LUMA = fx(`void main() { fragColor = vec4(dot(src().rgb, LUMA709)); }`)

export const EXPOSURE = fx(`
uniform float uEV;
vec3 srgbToLinear(vec3 c) {
  vec3 a = abs(c);
  return sign(c) * mix(pow((a + 0.055) / 1.055, vec3(2.4)), a / 12.92, vec3(lessThanEqual(a, vec3(0.04045))));
}
vec3 linearToSrgb(vec3 c) {
  vec3 a = abs(c);
  return sign(c) * mix(1.055 * pow(a, vec3(1.0 / 2.4)) - 0.055, a * 12.92, vec3(lessThanEqual(a, vec3(0.0031308))));
}
void main() {
  vec4 s = src();
  fragColor = vec4(linearToSrgb(srgbToLinear(s.rgb) * exp2(uEV)), s.a);
}`)

export const CONTRAST = fx(`
uniform float uAmount;
void main() { vec4 s = src(); fragColor = vec4((s.rgb - 0.5) * uAmount + 0.5, s.a); }`)

export const SATURATION = fx(`
uniform float uAmount;
void main() {
  vec4 s = src(); float l = dot(s.rgb, vec3(0.2125, 0.7154, 0.0721));
  fragColor = vec4(mix(vec3(l), s.rgb, uAmount), s.a);
}`)

export const MATRIX = fx(`
uniform mat3 uM;
void main() { vec4 s = src(); fragColor = vec4(uM * s.rgb, s.a); }`)

export const HIGHLIGHTS_SHADOWS = fx(`
uniform float uHighlights, uShadows;
void main() {
  vec4 s = src();
  float y = dot(clamp(s.rgb, 0.0, 1.0), LUMA709);
  float hi = y * y * y;
  float lo = (1.0 - y) * (1.0 - y) * (1.0 - y);
  float dY = (uHighlights * hi + uShadows * lo) * 0.5;
  fragColor = vec4(clamp(s.rgb + dY, 0.0, 1.0), s.a);
}`)

export const LEVELS = fx(`
uniform float uBlacks, uWhites;
void main() {
  vec4 s = src();
  float bp = -uBlacks * 0.4;
  float wp = 1.0 - uWhites * 0.4;
  fragColor = vec4(clamp((s.rgb - bp) / max(0.05, wp - bp), 0.0, 1.0), s.a);
}`)

export const VIBRANCE = fx(`
uniform float uAmount;
void main() {
  vec4 s = src();
  float mx = max(s.r, max(s.g, s.b)), mn = min(s.r, min(s.g, s.b));
  float sat = clamp(mx - mn, 0.0, 1.0);
  float l = dot(s.rgb, vec3(0.2125, 0.7154, 0.0721));
  float k = 1.0 + uAmount * (1.0 - sat);
  fragColor = vec4(mix(vec3(l), s.rgb, k), s.a);
}`)

export const WHEELS = fx(`
uniform vec3 uLift, uGain, uInvGamma;
void main() {
  vec4 s = src();
  vec3 lit = max(s.rgb * (1.0 - uLift) + uLift, vec3(0.0)) * uGain;
  fragColor = vec4(clamp(pow(lit, uInvGamma), 0.0, 1.0), s.a);
}`)

export const CURVES = fx(`
uniform sampler2D uCh;
uniform sampler2D uMaster;
void main() {
  vec4 s = src();
  vec3 rgb = clamp(s.rgb, 0.0, 1.0);
  float y = dot(rgb, LUMA709);
  float yp = lut1D(uMaster, y).r;
  rgb = (y > 1e-4) ? rgb * min(yp / y, 8.0) : vec3(yp);
  fragColor = vec4(lut1D(uCh, rgb.r).r, lut1D(uCh, rgb.g).g, lut1D(uCh, rgb.b).b, s.a);
}`)

export const HUE_CURVES = fx(`
uniform sampler2D uLut;
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
void main() {
  vec4 s = src();
  vec3 hsv = rgb2hsv(clamp(s.rgb, 0.0, 1.0));
  vec4 L = lut1D(uLut, hsv.x);
  float gate = smoothstep(0.04, 0.18, hsv.y);
  float h2 = fract(hsv.x + L.r * gate);
  float s2 = clamp(hsv.y * (1.0 + L.g * gate), 0.0, 1.0);
  float v2 = clamp(hsv.z + L.b * gate, 0.0, 1.0);
  fragColor = vec4(hsv2rgb(vec3(h2, s2, v2)), s.a);
}`)

export const LUT3D = fx(`
uniform highp sampler3D uLut;
uniform float uN;
uniform float uIntensity;
vec3 L(vec3 idx) { return texelFetch(uLut, ivec3(idx), 0).rgb; }
void main() {
  vec4 s = src();
  vec3 rgb = clamp(s.rgb, 0.0, 1.0);
  vec3 p = rgb * (uN - 1.0);
  vec3 b0 = clamp(floor(p), 0.0, uN - 2.0);
  vec3 f = p - b0;
  vec3 c000 = L(b0), c111 = L(b0 + 1.0), o;
  if (f.r >= f.g) {
    if (f.g >= f.b)      o = (1.0 - f.r) * c000 + (f.r - f.g) * L(b0 + vec3(1, 0, 0)) + (f.g - f.b) * L(b0 + vec3(1, 1, 0)) + f.b * c111;
    else if (f.r >= f.b) o = (1.0 - f.r) * c000 + (f.r - f.b) * L(b0 + vec3(1, 0, 0)) + (f.b - f.g) * L(b0 + vec3(1, 0, 1)) + f.g * c111;
    else                 o = (1.0 - f.b) * c000 + (f.b - f.r) * L(b0 + vec3(0, 0, 1)) + (f.r - f.g) * L(b0 + vec3(1, 0, 1)) + f.g * c111;
  } else {
    if (f.b >= f.g)      o = (1.0 - f.b) * c000 + (f.b - f.g) * L(b0 + vec3(0, 0, 1)) + (f.g - f.r) * L(b0 + vec3(0, 1, 1)) + f.r * c111;
    else if (f.b >= f.r) o = (1.0 - f.g) * c000 + (f.g - f.b) * L(b0 + vec3(0, 1, 0)) + (f.b - f.r) * L(b0 + vec3(0, 1, 1)) + f.r * c111;
    else                 o = (1.0 - f.g) * c000 + (f.g - f.r) * L(b0 + vec3(0, 1, 0)) + (f.r - f.b) * L(b0 + vec3(1, 1, 0)) + f.b * c111;
  }
  fragColor = vec4(mix(s.rgb, o, uIntensity), s.a);
}`)

export const CLARITY = fx(`
uniform sampler2D uBlur;
uniform float uClarity, uDehaze;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uSrc, p, 0);
  vec3 b = texelFetch(uBlur, p, 0).rgb;
  vec3 rgb = s.rgb + (s.rgb - b) * uClarity;
  if (uDehaze != 0.0) {
    float dark = min(s.r, min(s.g, s.b));
    float w = uDehaze * (0.5 + 0.5 * smoothstep(0.05, 0.5, dark));
    rgb += (s.rgb - b) * (w * 0.6);
    rgb = mix(vec3(0.45), rgb, 1.0 + w * 0.45);
    float yy = dot(rgb, LUMA709);
    rgb = mix(vec3(yy), rgb, 1.0 + w * 0.5);
  }
  fragColor = vec4(clamp(rgb, 0.0, 1.0), s.a);
}`)

export const CHROMA_KEY = fx(`
uniform float uKeyHue, uTolerance, uSoftness, uSpill;
void main() {
  vec4 s = src(); vec3 rgb = s.rgb;
  float mx = max(rgb.r, max(rgb.g, rgb.b)), mn = min(rgb.r, min(rgb.g, rgb.b));
  float dd = mx - mn;
  float sat = mx <= 1e-5 ? 0.0 : dd / mx;
  float hue = 0.0;
  if (dd > 1e-5) {
    if (mx == rgb.r)      hue = (rgb.g - rgb.b) / dd;
    else if (mx == rgb.g) hue = (rgb.b - rgb.r) / dd + 2.0;
    else                  hue = (rgb.r - rgb.g) / dd + 4.0;
    hue = fract(hue / 6.0);
  }
  float hd = abs(hue - uKeyHue); hd = min(hd, 1.0 - hd);
  float inner = uTolerance * 0.25;
  float key = (1.0 - smoothstep(inner, inner + uSoftness * 0.3 + 0.02, hd))
            * smoothstep(0.12, 0.32, sat)
            * smoothstep(0.04, 0.12, dd);
  float y = dot(rgb, LUMA709);
  rgb = mix(rgb, vec3(y), uSpill * key);
  fragColor = vec4(rgb, s.a * (1.0 - key));
}`)

export const SHARPEN = fx(`
uniform sampler2D uLumaBlur;
uniform float uSharpness;
void main() {
  vec4 s = src();
  float y = dot(s.rgb, LUMA709);
  float yb = texelFetch(uLumaBlur, ivec2(gl_FragCoord.xy), 0).r;
  fragColor = vec4(s.rgb + (y - yb) * uSharpness, s.a);
}`)

export const NOISE_REDUCTION = fx(`
uniform float uNoise;
uniform float uSharp;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = srcClamped(p);
  float yc = dot(c.rgb, LUMA709);
  vec3 acc = vec3(0.0), box = vec3(0.0); float wsum = 0.0;
  for (int j = -2; j <= 2; ++j) for (int i = -2; i <= 2; ++i) {
    vec3 n = srcClamped(p + ivec2(i, j)).rgb;
    box += n;
    float w = 1.0 - sstep(uNoise, 2.0 * uNoise + 1e-4, abs(dot(n, LUMA709) - yc));
    acc += n * w; wsum += w;
  }
  box /= 25.0;
  vec3 den = acc / wsum;
  float edge = sstep(uNoise, 2.0 * uNoise + 1e-4, abs(yc - dot(box, LUMA709)));
  fragColor = vec4(mix(den, c.rgb + (c.rgb - box) * uSharp, edge), c.a);
}`)

export const MOTION_BLUR = fx(`
uniform float uRadius;
uniform float uAngle;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 dir = vec2(cos(uAngle), -sin(uAngle));
  int n = int(ceil(uRadius));
  vec4 acc = vec4(0.0); float wsum = 0.0;
  for (int i = -n; i <= n; ++i) {
    float t = float(i);
    float w = 1.0 - abs(t) / (uRadius + 1.0);
    acc += w * bilinearClamped(p + dir * t); wsum += w;
  }
  fragColor = acc / wsum;
}`)

export const INVERT = fx(`void main() { vec4 s = src(); fragColor = vec4(1.0 - s.rgb, s.a); }`)

export const GRAIN = fx(`
uniform float uAmount, uSize, uFrame;
uniform vec2 uOrigin;
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
void main() {
  vec4 s = src();
  vec2 co = (gl_FragCoord.xy + uOrigin) / max(uSize, 0.5);
  float n = hash13(vec3(co, uFrame)) - 0.5;
  float y = dot(s.rgb, LUMA709);
  float lumaMask = 4.0 * y * (1.0 - y);
  fragColor = vec4(clamp(s.rgb + n * uAmount * 0.35 * lumaMask, 0.0, 1.0), s.a);
}`)

export const VIGNETTE = fx(`
uniform float uAmount, uMidpoint, uRoundness, uFeather;
void main() {
  vec4 s = src();
  vec2 center = uExtent * 0.5;
  vec2 d = (gl_FragCoord.xy - center) / max(uExtent * 0.5, vec2(1.0));
  float p = mix(6.0, 2.0, (uRoundness + 1.0) * 0.5);
  float dist = pow(pow(abs(d.x), p) + pow(abs(d.y), p), 1.0 / p);
  float v = smoothstep(uMidpoint, uMidpoint + uFeather * 1.5 + 0.05, dist);
  fragColor = vec4(clamp(s.rgb * (1.0 + uAmount * v), 0.0, 1.0), s.a);
}`)

export const GLOW_BRIGHT = fx(`
uniform float uThreshold, uWarmth;
void main() {
  vec4 s = src();
  float y = dot(s.rgb, LUMA709);
  vec3 hi = s.rgb * sstep(uThreshold, 1.0, y);
  vec3 warm = hi * vec3(1.0, 0.7, 0.45);
  fragColor = vec4(mix(hi, warm, uWarmth), s.a);
}`)

export const GLOW_COMPOSITE = fx(`
uniform sampler2D uGlow;
uniform float uIntensity;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uSrc, p, 0);
  vec3 g = clamp(texelFetch(uGlow, p, 0).rgb * uIntensity, 0.0, 1.0);
  fragColor = vec4(1.0 - (1.0 - s.rgb) * (1.0 - g), s.a);
}`)

export const EDGE_ROUNDING = fx(`
uniform float uRounding;
uniform float uSoftness;
void main() {
  vec4 s = src();
  float m = min(uExtent.x, uExtent.y);
  float radius  = uRounding * m * 0.5;
  float feather = uSoftness * m * 0.5;
  vec2 center = uExtent * 0.5;
  vec2 q = abs(gl_FragCoord.xy - center) - (uExtent * 0.5 - radius);
  float dist = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - radius;
  float coverage = 1.0 - smoothstep(-0.5 - feather, 0.5, dist);
  fragColor = vec4(s.rgb, s.a * coverage);
}`)

/**
 * Crop copy (§5.2): resamples the source texture (any decode size) into source-px space, times `uScale`
 * (preview work scale, §12). Exact copy when the texture is natW × natH and the scale is 1.
 */
export const CROP_COPY = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uOrigin;
uniform vec2 uNat;
uniform float uScale;
out vec4 fragColor;
void main() {
  vec2 p = gl_FragCoord.xy / uScale + uOrigin;
  if (uScale >= 0.75) { fragColor = texture(uTex, p / uNat); return; }
  // [APPROX] preview minification without mipmaps: four bilinear taps across the footprint.
  vec2 d = vec2(0.25 / uScale);
  fragColor = 0.25 * (texture(uTex, (p - d) / uNat) + texture(uTex, (p + d) / uNat)
                    + texture(uTex, (p + vec2(d.x, -d.y)) / uNat) + texture(uTex, (p + vec2(-d.x, d.y)) / uNat));
}`

/**
 * Preview video frame from CPU Y'CbCr planes to straight RGBA8 (§7.2: matrix and range only).
 * [APPROX] chroma is interpolated centre-sited (FFmpeg's 4:2:0 default is left-sited): sub-pixel.
 */
export const YUV_TO_RGB = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uY;
uniform sampler2D uCb;
uniform sampler2D uCr;
uniform sampler2D uA;
uniform bool uInterleaved;
uniform bool uAlpha;
uniform vec2 uSize;
uniform mat3 uM;
uniform vec3 uOffset;
out vec4 fragColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 uv = gl_FragCoord.xy / uSize;
#ifdef SCALED
  // Converted at the preview work size (uSize = output size): four bilinear luma taps across the footprint.
  vec2 d = 0.25 / uSize;
  float y = 0.25 * (texture(uY, uv - d).r + texture(uY, uv + d).r + texture(uY, uv + vec2(d.x, -d.y)).r + texture(uY, uv + vec2(-d.x, d.y)).r);
  float a = texture(uA, uv).r;
#else
  float y = texelFetch(uY, p, 0).r;
  float a = texelFetch(uA, p, 0).r;
#endif
  vec2 c = uInterleaved ? texture(uCb, uv).rg : vec2(texture(uCb, uv).r, texture(uCr, uv).r);
  vec3 rgb = uM * (vec3(y, c) - uOffset);
  fragColor = vec4(clamp(rgb, 0.0, 1.0), uAlpha ? a : 1.0);
}`

const PLACE_COMMON = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uLayer;
uniform vec2 uLayerSize;
uniform vec2 uCropOrigin;
uniform mat3 uCanvasToSource;
uniform bool uProjective;
uniform float uOpacity;
uniform vec2 uMul;
uniform bool uAlphaAsColor;
uniform float uLayerScale;
out vec4 fragColor;

vec4 fetchLayer(ivec2 i) {
  if (any(lessThan(i, ivec2(0))) || any(greaterThanEqual(i, ivec2(uLayerSize)))) return vec4(0.0);
  return texelFetch(uLayer, i, 0);
}
vec4 bilinearLayer(vec2 x) {
#if defined(ALIGNED)
  // Pixel centres map onto texel centres: bilinear weights are exactly 0.
  return fetchLayer(ivec2(floor(x)));
#elif defined(HW_FILTER)
  // [APPROX] preview: hardware bilinear (edge-clamped) times the transparent border's coverage, i.e. the
  // four-tap result below up to the filter's weight precision.
  vec2 cov = clamp(x + 0.5, 0.0, 1.0) * clamp(uLayerSize + 0.5 - x, 0.0, 1.0);
  return texture(uLayer, x / uLayerSize) * (cov.x * cov.y);
#else
  x -= 0.5; ivec2 i = ivec2(floor(x)); vec2 f = x - floor(x);
  return mix(mix(fetchLayer(i), fetchLayer(i + ivec2(1, 0)), f.x),
             mix(fetchLayer(i + ivec2(0, 1)), fetchLayer(i + ivec2(1, 1)), f.x), f.y);
#endif
}
vec4 layerAt(vec2 p) {
  vec3 q = uCanvasToSource * vec3(p, 1.0);
  if (uProjective && q.z <= 0.0) return vec4(0.0);
  vec2 srcPx = uProjective ? q.xy / q.z : q.xy;
  vec4 c = bilinearLayer((srcPx - uCropOrigin) * uLayerScale);
  c.rgb *= uMul.x; c.a *= uMul.y;
  if (uAlphaAsColor) c.rgb = vec3(c.a);
  return c;
}
`

/** Normal (source-over) layer: premultiplied output, composited with GL blending ONE, ONE_MINUS_SRC_ALPHA. */
export const PLACE_NORMAL = PLACE_COMMON + `
void main() {
  vec4 c = layerAt(gl_FragCoord.xy);
  float a = c.a * uOpacity;
  fragColor = vec4(c.rgb * a, a);
}`

/** Normal layer over the still-black accumulator: the blend result written directly, no clear or blending. */
export const PLACE_FIRST = PLACE_COMMON + `
void main() {
  vec4 c = layerAt(gl_FragCoord.xy);
  fragColor = vec4(c.rgb * (c.a * uOpacity), 1.0);
}`

/**
 * Top normal layer straight into the clamped 8-bit output: source-over of the backdrop (black with OVER_BLACK)
 * and TO_RGBA8 in one pass.
 */
export const PLACE_OUT8 = PLACE_COMMON + `
uniform sampler2D uBackdrop;
void main() {
  vec4 c = layerAt(gl_FragCoord.xy);
  float a = c.a * uOpacity;
#ifdef OVER_BLACK
  vec3 b = vec3(0.0);
#else
  vec3 b = texelFetch(uBackdrop, ivec2(gl_FragCoord.xy), 0).rgb;
#endif
  fragColor = vec4(clamp(c.rgb * a + b * (1.0 - a), 0.0, 1.0), 1.0);
}`

/** Non-normal blend modes (§6.3–§6.4): reads the backdrop, writes the full result. */
export const PLACE_BLEND = PLACE_COMMON + `
uniform sampler2D uBackdrop;
uniform int uMode;
vec3 bScreen(vec3 s, vec3 b) { return s + b - s * b; }
vec3 bHardLight(vec3 s, vec3 b) { return mix(b * 2.0 * s, bScreen(2.0 * s - 1.0, b), step(0.5, s)); }
float dodge1(float s, float b) { if (b <= 0.0) return 0.0; if (s >= 1.0) return 1.0; return min(1.0, b / (1.0 - s)); }
float burn1(float s, float b)  { if (b >= 1.0) return 1.0; if (s <= 0.0) return 0.0; return 1.0 - min(1.0, (1.0 - b) / s); }
float soft1(float s, float b) {
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(max(b, 0.0));
  return b + (2.0 * s - 1.0) * (d - b);
}
float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c), n = min(c.r, min(c.g, c.b)), x = max(c.r, max(c.g, c.b));
  if (n < 0.0 && l - n > 1e-6) c = l + (c - l) * l / (l - n);
  if (x > 1.0 && x - l > 1e-6) c = l + (c - l) * (1.0 - l) / (x - l);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float satOf(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
vec3 setSat(vec3 c, float s) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}
vec3 blendFn(int m, vec3 s, vec3 b) {
  if (m == 1)  return min(s, b);
  if (m == 2)  return s * b;
  if (m == 3)  return vec3(burn1(s.r, b.r), burn1(s.g, b.g), burn1(s.b, b.b));
  if (m == 4)  return max(s, b);
  if (m == 5)  return bScreen(s, b);
  if (m == 6)  return vec3(dodge1(s.r, b.r), dodge1(s.g, b.g), dodge1(s.b, b.b));
  if (m == 7)  return bHardLight(b, s);
  if (m == 8)  return vec3(soft1(s.r, b.r), soft1(s.g, b.g), soft1(s.b, b.b));
  if (m == 9)  return bHardLight(s, b);
  if (m == 10) return abs(s - b);
  if (m == 11) return s + b - 2.0 * s * b;
  if (m == 12) return setLum(setSat(s, satOf(b)), lum(b));
  if (m == 13) return setLum(setSat(b, satOf(s)), lum(b));
  if (m == 14) return setLum(s, lum(b));
  return setLum(b, lum(s));
}
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 c = layerAt(p);
  vec4 B = texelFetch(uBackdrop, ivec2(p), 0);
  vec3 blended = (1.0 - c.a) * B.rgb + c.a * blendFn(uMode, c.rgb, B.rgb);
  fragColor = vec4(mix(B.rgb, blended, uOpacity), 1.0);
}`

/** Resamples a layer into a straight-alpha working image (text entrance into the effect extent). */
export const RESAMPLE = PLACE_COMMON + `
void main() { fragColor = layerAt(gl_FragCoord.xy); }`

/** Footage fill (§9.11): glyph coverage reveals the accumulator, the rest shows the matte colour. */
export const FOOTAGE_STENCIL = PLACE_COMMON + `
uniform sampler2D uBackdrop;
uniform vec4 uMatte;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 c = layerAt(p);
  vec3 maskRgb = c.rgb * c.a;
  float m = clamp(dot(maskRgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  vec3 B = texelFetch(uBackdrop, ivec2(p), 0).rgb;
  vec3 matte = uMatte.rgb * uMatte.a + B * (1.0 - uMatte.a);
  fragColor = vec4(mix(matte, B, m), 1.0);
}`

/** Cross-dissolve of two canvas images (footage opacity). */
export const DISSOLVE = `#version 300 es
precision highp float;
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uT;
out vec4 fragColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  fragColor = vec4(mix(texelFetch(uA, p, 0).rgb, texelFetch(uB, p, 0).rgb, uT), 1.0);
}`

/** Clamped 8-bit output of the accumulator (readPixels gets the top row first). */
export const TO_RGBA8 = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
out vec4 fragColor;
void main() {
  vec4 c = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0);
  fragColor = vec4(clamp(c.rgb, 0.0, 1.0), 1.0);
}`

/** Draws the accumulator into the default framebuffer (bottom-up) inside a letterbox viewport. */
export const PRESENT = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec4 uViewport;
out vec4 fragColor;
void main() {
  vec2 uv = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) { fragColor = vec4(0.0); return; }
  uv.y = 1.0 - uv.y;
  vec4 c = texture(uSrc, uv);
  fragColor = vec4(clamp(c.rgb, 0.0, 1.0), 1.0);
}`
