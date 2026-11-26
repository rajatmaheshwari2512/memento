// SelfPhotos Adjust: runs the shared shader (adjust-core.glsl) with WebGL2, for the live preview,
// the filter thumbnails and the tiles of the full-size render.

import core from '#lib/ai-edit/adjust/adjust-core.glsl?raw';
import { IDENTITY, framing, type Quad, type Rect, type Size } from '#lib/ai-edit/adjust/adjust-geometry.ts';
import type { ShaderValues } from '#lib/ai-edit/adjust/adjust-params.ts';

const VERTEX = `#version 300 es
in vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2D;
${core}
uniform float uFlipY; // the render's height when it's shown on screen, else 0
out vec4 fragColor;
void main() {
  vec2 p = gl_FragCoord.xy;
  if (uFlipY > 0.0) {
    p.y = uFlipY - p.y;
  }
  fragColor = adjustPixel(p);
}
`;

const FLOATS = [
  'exposure',
  'brightness',
  'contrast',
  'highlights',
  'shadows',
  'saturation',
  'warmth',
  'tint',
  'vignette',
  'fade',
] as const;

export class AdjustUnsupportedError extends Error {}

// One render: which part of the output to draw (the canvas is that size), from which part of the
// source the texture holds.
export type RenderJob = {
  values: ShaderValues;
  degrees: number;
  perspective?: Quad | null;
  source: Size;
  output: Size;
  tile: Rect;
  texture: Rect;
  onScreen: boolean;
};

export class AdjustRenderer {
  readonly maxTextureSize: number;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly buffer: WebGLBuffer;
  private readonly texture: WebGLTexture;
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      depth: false,
      stencil: false,
    }) as WebGL2RenderingContext | null;
    if (!gl) {
      throw new AdjustUnsupportedError('WebGL 2 is not available');
    }
    this.gl = gl;
    this.maxTextureSize = Math.min(
      gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
    );

    this.program = gl.createProgram();
    for (const [type, source] of [
      [gl.VERTEX_SHADER, VERTEX],
      [gl.FRAGMENT_SHADER, FRAGMENT],
    ] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`Adjust shader: ${gl.getShaderInfoLog(shader)}`);
      }
      gl.attachShader(this.program, shader);
    }
    gl.bindAttribLocation(this.program, 0, 'aPosition');
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error(`Adjust shader: ${gl.getProgramInfoLog(this.program)}`);
    }

    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  get ok() {
    return !this.gl.isContextLost() && this.gl.getError() === this.gl.NO_ERROR;
  }

  setImage(image: TexImageSource, shrunk = false) {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, shrunk ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    if (shrunk) {
      gl.generateMipmap(gl.TEXTURE_2D);
    }
  }

  render({ values, degrees, perspective, source, output, tile, texture, onScreen }: RenderJob) {
    const { gl } = this;
    const view = framing(degrees, source, perspective);
    const toPhoto = view.toPhoto ?? IDENTITY;
    gl.viewport(0, 0, tile.width, tile.height);
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.uniform('uTexture'), 0);
    gl.uniform2f(this.uniform('uTexOrigin'), texture.x, texture.y);
    gl.uniform2f(this.uniform('uTexSize'), texture.width, texture.height);
    gl.uniform2f(this.uniform('uSrcSize'), source.width, source.height);
    gl.uniform2f(this.uniform('uOutSize'), output.width, output.height);
    gl.uniform2f(this.uniform('uTileOrigin'), tile.x, tile.y);
    gl.uniform2f(this.uniform('uRotation'), ...view.rotation);
    gl.uniform2f(this.uniform('uCropScale'), ...view.scale);
    gl.uniform2f(this.uniform('uCropCentre'), ...view.centre);
    gl.uniform3f(this.uniform('uPerspectiveX'), toPhoto[0], toPhoto[1], toPhoto[2]);
    gl.uniform3f(this.uniform('uPerspectiveY'), toPhoto[3], toPhoto[4], toPhoto[5]);
    gl.uniform3f(this.uniform('uPerspectiveW'), toPhoto[6], toPhoto[7], toPhoto[8]);
    gl.uniform1f(this.uniform('uPremultiplied'), 0);
    gl.uniform1f(this.uniform('uFlipY'), onScreen ? tile.height : 0);
    for (const name of FLOATS) {
      gl.uniform1f(this.uniform(`u${name[0].toUpperCase()}${name.slice(1)}`), values[name]);
    }
    gl.uniform3f(this.uniform('uToneShadows'), ...values.toneShadows);
    gl.uniform3f(this.uniform('uToneHighlights'), ...values.toneHighlights);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  read(width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
    const pixels = new Uint8ClampedArray(width * height * 4);
    this.gl.readPixels(0, 0, width, height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixels);
    return pixels;
  }

  dispose() {
    const { gl } = this;
    gl.deleteTexture(this.texture);
    gl.deleteBuffer(this.buffer);
    gl.deleteProgram(this.program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  private uniform(name: string) {
    if (!this.uniforms.has(name)) {
      this.uniforms.set(name, this.gl.getUniformLocation(this.program, name));
    }
    return this.uniforms.get(name)!;
  }
}
