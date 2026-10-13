export const FULLSCREEN_VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

export interface Program {
  program: WebGLProgram
  uniforms: Map<string, WebGLUniformLocation | null>
}

export interface RenderTarget {
  texture: WebGLTexture
  framebuffer: WebGLFramebuffer
  width: number
  height: number
  /** RGBA16F working targets vs RGBA8 output targets. */
  float: boolean
}

const POOL_LIMIT = 48

/**
 * Thin WebGL2 helper: program cache, a fullscreen quad and pooled render targets.
 * All textures are stored top row first, so `gl_FragCoord.xy` is a y-down pixel coordinate (spec 04 §0.1).
 */
export class GL {
  readonly gl: WebGL2RenderingContext
  private readonly programs = new Map<string, Program>()
  private readonly quad: WebGLVertexArrayObject
  private readonly pool: RenderTarget[] = []
  private readonly live = new Set<RenderTarget>()

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
    }) as WebGL2RenderingContext | null
    if (!gl) throw new Error('WebGL2 is not available')
    this.gl = gl
    if (!gl.getExtension('EXT_color_buffer_float')) gl.getExtension('EXT_color_buffer_half_float')
    gl.getExtension('OES_texture_float_linear')
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    const vao = gl.createVertexArray()!
    gl.bindVertexArray(vao)
    const buf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
    this.quad = vao
  }

  program(key: string, fragment: string, vertex = FULLSCREEN_VERT): Program {
    const cached = this.programs.get(key)
    if (cached) return cached
    const gl = this.gl
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s)
        gl.deleteShader(s)
        throw new Error(`Shader ${key} failed to compile: ${log}`)
      }
      return s
    }
    const program = gl.createProgram()!
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex))
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment))
    gl.bindAttribLocation(program, 0, 'aPos')
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program ${key} failed to link: ${gl.getProgramInfoLog(program)}`)
    }
    const entry: Program = { program, uniforms: new Map() }
    this.programs.set(key, entry)
    return entry
  }

  /** A program compiled earlier under `key`, so callers can skip building its source. */
  cached(key: string): Program | undefined {
    return this.programs.get(key)
  }

  use(p: Program): void {
    this.gl.useProgram(p.program)
  }

  loc(p: Program, name: string): WebGLUniformLocation | null {
    let l = p.uniforms.get(name)
    if (l === undefined) {
      l = this.gl.getUniformLocation(p.program, name)
      p.uniforms.set(name, l)
    }
    return l
  }

  uniforms(p: Program, values: Record<string, number | boolean | number[] | Float32Array>): void {
    const gl = this.gl
    for (const [name, v] of Object.entries(values)) {
      const l = this.loc(p, name)
      if (l === null) continue
      if (typeof v === 'number') gl.uniform1f(l, v)
      else if (typeof v === 'boolean') gl.uniform1i(l, v ? 1 : 0)
      else if (v.length === 2) gl.uniform2fv(l, v)
      else if (v.length === 3) gl.uniform3fv(l, v)
      else if (v.length === 4) gl.uniform4fv(l, v)
      else if (v.length === 9) gl.uniformMatrix3fv(l, false, v)
      else if (v.length === 16) gl.uniformMatrix4fv(l, false, v)
      else gl.uniform1fv(l, v)
    }
  }

  f1(p: Program, name: string, x: number): void {
    const l = this.loc(p, name)
    if (l !== null) this.gl.uniform1f(l, x)
  }

  f2(p: Program, name: string, x: number, y: number): void {
    const l = this.loc(p, name)
    if (l !== null) this.gl.uniform2f(l, x, y)
  }

  f3(p: Program, name: string, x: number, y: number, z: number): void {
    const l = this.loc(p, name)
    if (l !== null) this.gl.uniform3f(l, x, y, z)
  }

  f4(p: Program, name: string, x: number, y: number, z: number, w: number): void {
    const l = this.loc(p, name)
    if (l !== null) this.gl.uniform4f(l, x, y, z, w)
  }

  mat3(p: Program, name: string, m: Float32Array): void {
    const l = this.loc(p, name)
    if (l !== null) this.gl.uniformMatrix3fv(l, false, m)
  }

  intUniform(p: Program, name: string, value: number): void {
    const l = this.loc(p, name)
    if (l !== null) this.gl.uniform1i(l, value)
  }

  bindTexture(p: Program, name: string, unit: number, texture: WebGLTexture, target: number = this.gl.TEXTURE_2D): void {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(target, texture)
    this.intUniform(p, name, unit)
  }

  draw(target: RenderTarget | null, width?: number, height?: number): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null)
    gl.viewport(0, 0, target ? target.width : (width ?? gl.drawingBufferWidth), target ? target.height : (height ?? gl.drawingBufferHeight))
    gl.bindVertexArray(this.quad)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
  }

  createTexture(filter: number = this.gl.LINEAR): WebGLTexture {
    const gl = this.gl
    const t = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }

  /** 1-row RGBA32F table for texelFetch lookups (curves, hue curves). */
  tableTexture(data: Float32Array): WebGLTexture {
    const gl = this.gl
    const t = this.createTexture(gl.NEAREST)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, data.length / 4, 1, 0, gl.RGBA, gl.FLOAT, data)
    return t
  }

  /** Working targets are RGBA16F straight-alpha images (Core Image's half-float working format). */
  acquire(width: number, height: number): RenderTarget {
    return this.take(width, height, true)
  }

  /** RGBA8 targets for 8-bit output (readPixels). */
  acquire8(width: number, height: number): RenderTarget {
    return this.take(width, height, false)
  }

  private take(width: number, height: number, float: boolean): RenderTarget {
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    const i = this.pool.findIndex((t) => t.width === w && t.height === h && t.float === float)
    let t: RenderTarget
    if (i >= 0) t = this.pool.splice(i, 1)[0]
    else {
      const gl = this.gl
      const texture = this.createTexture()
      if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null)
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      const framebuffer = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      t = { texture, framebuffer, width: w, height: h, float }
    }
    this.live.add(t)
    return t
  }

  release(t: RenderTarget | null | undefined): void {
    if (!t || !this.live.delete(t)) return
    this.pool.push(t)
    while (this.pool.length > POOL_LIMIT) this.destroy(this.pool.shift()!)
  }

  /** Frees pooled targets (e.g. after the output size changes). */
  trimPool(): void {
    while (this.pool.length) this.destroy(this.pool.pop()!)
  }

  private destroy(t: RenderTarget): void {
    this.gl.deleteTexture(t.texture)
    this.gl.deleteFramebuffer(t.framebuffer)
  }

  clear(target: RenderTarget | null, r = 0, g = 0, b = 0, a = 0): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null)
    gl.viewport(0, 0, target ? target.width : gl.drawingBufferWidth, target ? target.height : gl.drawingBufferHeight)
    gl.clearColor(r, g, b, a)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  dispose(): void {
    this.trimPool()
    for (const t of this.live) this.destroy(t)
    this.live.clear()
    for (const p of this.programs.values()) this.gl.deleteProgram(p.program)
    this.programs.clear()
  }
}
