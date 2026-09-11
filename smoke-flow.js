/* Fluid cursor wake. Reference: Rustam Abrahamyan's Smoke Simulation,
 * https://codepen.io/RustamAbraham/pen/jYLXZm (semi-Lagrangian WebGL fluid).
 * This implementation adds time-based decay and a rounded-card solid boundary.
 * No dependencies; rendering never receives pointer events.
 */
(() => {
  'use strict';
  window.createCardSmoke = function (canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: true, premultipliedAlpha: false, depth: false, stencil: false,
      antialias: false, powerPreference: 'low-power', preserveDrawingBuffer: false
    });
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
    const vertex = `#version 300 es
      out vec2 uv;
      void main() {
        vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
        uv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
      }`;
    const header = `#version 300 es
      precision highp float;
      precision highp sampler2D;
      in vec2 uv; out vec4 result;
      uniform vec2 texel, viewport;
      uniform vec4 obstacle;
      uniform float corner;
      float distanceToCard(vec2 q) {
        vec2 center = (obstacle.xy + obstacle.zw) * .5;
        vec2 halfSize = max((obstacle.zw - obstacle.xy) * .5, vec2(0.0));
        float r = min(corner, min(halfSize.x, halfSize.y));
        vec2 d = abs(q * viewport - center) - halfSize + r;
        return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
      }
      bool solid(vec2 q) {
        return q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0 || distanceToCard(q) < 0.0;
      }
      vec2 wallVelocity(sampler2D field, vec2 q, vec2 center, vec2 reflection) {
        return solid(q) ? texture(field, center).xy * reflection : texture(field, q).xy;
      }`;
    function shader(type, source) {
      const s = gl.createShader(type);
      gl.shaderSource(s, source); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(s); gl.deleteShader(s); throw new Error(message);
      }
      return s;
    }
    const vs = shader(gl.VERTEX_SHADER, vertex);
    function program(body) {
      const fs = shader(gl.FRAGMENT_SHADER, header + body);
      const handle = gl.createProgram();
      gl.attachShader(handle, vs); gl.attachShader(handle, fs); gl.linkProgram(handle);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(handle));
      const uniforms = {};
      for (let i = 0; i < gl.getProgramParameter(handle, gl.ACTIVE_UNIFORMS); i++) {
        const name = gl.getActiveUniform(handle, i).name;
        uniforms[name] = gl.getUniformLocation(handle, name);
      }
      return { handle, uniforms };
    }
    const advect = program(`
      uniform sampler2D velocity, source;
      uniform float dt, decay;
      void main() {
        if (solid(uv)) { result = vec4(0.0); return; }
        vec2 from = uv - texture(velocity, uv).xy * texel * dt;
        if (solid(from)) {
          vec2 safe = uv, blocked = from;
          for (int i = 0; i < 6; i++) {
            vec2 middle = (safe + blocked) * .5;
            if (solid(middle)) blocked = middle; else safe = middle;
          }
          from = safe;
        }
        result = texture(source, clamp(from, texel * .5, 1.0 - texel * .5)) * exp(-decay * dt);
      }`);
    const inject = program(`
      uniform sampler2D source;
      uniform vec2 startPoint, endPoint;
      uniform vec3 amount;
      uniform float radius;
      void main() {
        if (solid(uv)) { result = vec4(0.0); return; }
        vec2 p = uv * viewport, a = startPoint * viewport, b = endPoint * viewport;
        vec2 ab = b - a;
        float t = clamp(dot(p - a, ab) / max(dot(ab, ab), .0001), 0.0, 1.0);
        vec2 offset = p - a - t * ab;
        float weight = exp(-dot(offset, offset) / (radius * radius));
        result = vec4(texture(source, uv).xyz + amount * weight, 1.0);
      }`);
    const curlPass = program(`
      uniform sampler2D velocity;
      void main() {
        if (solid(uv)) { result = vec4(0.0); return; }
        float l = wallVelocity(velocity, uv - vec2(texel.x, 0), uv, vec2(-1,1)).y;
        float r = wallVelocity(velocity, uv + vec2(texel.x, 0), uv, vec2(-1,1)).y;
        float b = wallVelocity(velocity, uv - vec2(0,texel.y), uv, vec2(1,-1)).x;
        float t = wallVelocity(velocity, uv + vec2(0,texel.y), uv, vec2(1,-1)).x;
        result = vec4((r-l-t+b)*.5, 0, 0, 1);
      }`);
    const swirlPass = program(`
      uniform sampler2D velocity, curl;
      uniform float dt;
      void main() {
        if (solid(uv)) { result = vec4(0.0); return; }
        float l = abs(texture(curl, uv - vec2(texel.x,0)).x);
        float r = abs(texture(curl, uv + vec2(texel.x,0)).x);
        float b = abs(texture(curl, uv - vec2(0,texel.y)).x);
        float t = abs(texture(curl, uv + vec2(0,texel.y)).x);
        vec2 gradient = vec2(t-b,r-l);
        gradient /= max(length(gradient), .0001);
        vec2 force = gradient * vec2(1,-1) * texture(curl,uv).x * 22.0;
        vec2 speed = texture(velocity,uv).xy + force * dt;
        result = vec4(clamp(speed,vec2(-650),vec2(650)),0,1);
      }`);
    const divergencePass = program(`
      uniform sampler2D velocity;
      void main() {
        if (solid(uv)) { result = vec4(0.0); return; }
        float l = wallVelocity(velocity, uv-vec2(texel.x,0), uv, vec2(-1,1)).x;
        float r = wallVelocity(velocity, uv+vec2(texel.x,0), uv, vec2(-1,1)).x;
        float b = wallVelocity(velocity, uv-vec2(0,texel.y), uv, vec2(1,-1)).y;
        float t = wallVelocity(velocity, uv+vec2(0,texel.y), uv, vec2(1,-1)).y;
        result = vec4((r-l+t-b)*.5,0,0,1);
      }`);
    const pressurePass = program(`
      uniform sampler2D pressure, divergence;
      float neighbor(vec2 q, float center) { return solid(q) ? center : texture(pressure,q).x; }
      void main() {
        if (solid(uv)) { result = vec4(0.0); return; }
        float c = texture(pressure,uv).x;
        float l = neighbor(uv-vec2(texel.x,0),c), r = neighbor(uv+vec2(texel.x,0),c);
        float b = neighbor(uv-vec2(0,texel.y),c), t = neighbor(uv+vec2(0,texel.y),c);
        result = vec4((l+r+b+t-texture(divergence,uv).x)*.25,0,0,1);
      }`);
    const project = program(`
      uniform sampler2D pressure, velocity;
      float neighbor(vec2 q, float center) { return solid(q) ? center : texture(pressure,q).x; }
      void main() {
        if (solid(uv)) { result = vec4(0.0); return; }
        float c = texture(pressure,uv).x;
        float l = neighbor(uv-vec2(texel.x,0),c), r = neighbor(uv+vec2(texel.x,0),c);
        float b = neighbor(uv-vec2(0,texel.y),c), t = neighbor(uv+vec2(0,texel.y),c);
        vec2 v = texture(velocity,uv).xy - .5 * vec2(r-l,t-b);
        if (solid(uv-vec2(texel.x,0)) && v.x<0.0 || solid(uv+vec2(texel.x,0)) && v.x>0.0) v.x=0.0;
        if (solid(uv-vec2(0,texel.y)) && v.y<0.0 || solid(uv+vec2(0,texel.y)) && v.y>0.0) v.y=0.0;
        result = vec4(v,0,1);
      }`);
    const show = program(`
      uniform sampler2D density;
      void main() {
        // Preserve the reference's direct RGB brightness over a transparent background.
        vec3 ink = clamp(texture(density,uv).rgb,0.0,1.0);
        float alpha = max(ink.r,max(ink.g,ink.b));
        vec3 color = ink / max(alpha,.001);
        result = vec4(color,alpha * smoothstep(0.0,3.0,distanceToCard(uv)));
      }`);
    gl.deleteShader(vs);
    gl.bindVertexArray(gl.createVertexArray());
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    let width=1, height=1, sw=1, sh=1, dw=1, dh=1;
    let bounds=[-1000,-1000,-999,-999], corner=24;
    let velocity, density, pressure, curl, divergence;
    const buffers=[];
    function target(w,h) {
      const texture=gl.createTexture(), framebuffer=gl.createFramebuffer();
      gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA16F,w,h,0,gl.RGBA,gl.HALF_FLOAT,null);
      gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
      if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE) throw new Error('Fluid framebuffer unavailable');
      const item={texture,framebuffer,w,h}; buffers.push(item);
      gl.viewport(0,0,w,h); gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
      return item;
    }
    function pair(w,h) { return {read:target(w,h),write:target(w,h),swap(){const t=this.read;this.read=this.write;this.write=t;}}; }
    function run(p,destination,values={}) {
      gl.useProgram(p.handle);
      gl.bindFramebuffer(gl.FRAMEBUFFER,destination ? destination.framebuffer : null);
      gl.viewport(0,0,destination ? destination.w : canvas.width,destination ? destination.h : canvas.height);
      let unit=0;
      for(const [name,value] of Object.entries({texel:[1/sw,1/sh],viewport:[width,height],obstacle:bounds,corner,...values})) {
        const loc=p.uniforms[name]; if(loc===undefined) continue;
        if(value && value.texture) {
          gl.activeTexture(gl.TEXTURE0+unit); gl.bindTexture(gl.TEXTURE_2D,value.texture); gl.uniform1i(loc,unit++);
        } else if(Array.isArray(value)) {
          if(value.length===2) gl.uniform2fv(loc,value);
          else if(value.length===3) gl.uniform3fv(loc,value);
          else gl.uniform4fv(loc,value);
        } else gl.uniform1f(loc,value);
      }
      gl.drawArrays(gl.TRIANGLES,0,3);
    }
    function resize(w,h,mobile) {
      width=w; height=h;
      const ratio=w/h, short=mobile ? 80 : 144, dye=mobile ? 180 : 360;
      const nw=Math.round(short*Math.max(1,ratio)), nh=Math.round(short/Math.min(1,ratio));
      canvas.width=Math.round(w*Math.min(devicePixelRatio||1,1.5));
      canvas.height=Math.round(h*Math.min(devicePixelRatio||1,1.5));
      if(velocity && Math.abs(nw/sw-1)<.09 && Math.abs(nh/sh-1)<.09) return;
      for(const b of buffers){gl.deleteTexture(b.texture);gl.deleteFramebuffer(b.framebuffer);} buffers.length=0;
      sw=nw; sh=nh; dw=Math.round(dye*Math.max(1,ratio)); dh=Math.round(dye/Math.min(1,ratio));
      velocity=pair(sw,sh); density=pair(dw,dh); pressure=pair(sw,sh); curl=target(sw,sh); divergence=target(sw,sh);
    }
    function boundary(rect) {
      bounds=[rect.left-3,height-rect.bottom-3,rect.right+3,height-rect.top+3];
      corner=rect.radius+3;
    }
    function splat(from,to,dt,color) {
      if(!velocity) return;
      const dx=to.x-from.x, dy=to.y-from.y, distance=Math.hypot(dx,dy);
      if(distance<.08) return;
      const duration=Math.max(dt,1/144), speed=Math.min(distance/duration,2200);
      const points={startPoint:[from.x/width,1-from.y/height],endPoint:[to.x/width,1-to.y/height],radius:Math.max(10,Math.min(height*.032,30))};
      const impulse=.35*dt*60;
      run(inject,velocity.write,{source:velocity.read,...points,amount:[dx/distance*speed*sw/width*impulse,-dy/distance*speed*sh/height*impulse,0]}); velocity.swap();
      const strength=.3*dt*60;
      run(inject,density.write,{source:density.read,...points,amount:color.map(c=>c*strength)}); density.swap();
    }
    function step(dt) {
      if(!velocity || gl.isContextLost()) return;
      run(advect,velocity.write,{velocity:velocity.read,source:velocity.read,dt,decay:.65}); velocity.swap();
      run(curlPass,curl,{velocity:velocity.read});
      run(swirlPass,velocity.write,{velocity:velocity.read,curl,dt}); velocity.swap();
      run(divergencePass,divergence,{velocity:velocity.read});
      // Warm-start pressure, followed by a fixed bounded number of Jacobi passes.
      for(let i=0;i<20;i++){run(pressurePass,pressure.write,{pressure:pressure.read,divergence});pressure.swap();}
      run(project,velocity.write,{pressure:pressure.read,velocity:velocity.read}); velocity.swap();
      run(advect,density.write,{velocity:velocity.read,source:density.read,dt,decay:1.02}); density.swap();
      run(show,null,{density:density.read});
    }
    function clear() {
      gl.clearColor(0,0,0,0);
      for(const b of buffers){gl.bindFramebuffer(gl.FRAMEBUFFER,b.framebuffer);gl.clear(gl.COLOR_BUFFER_BIT);}
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.clear(gl.COLOR_BUFFER_BIT);
    }
    return {resize,boundary,splat,step,clear};
  };
})();
