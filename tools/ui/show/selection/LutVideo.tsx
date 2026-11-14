import React from 'react';

// Tetrahedral interpolation matches the compositor's lut3d default. Successive
// LUTs are drawn in order through framebuffers, so a stack preserves its order.
export function LutVideo({video,luts,style,onError}:any){
 const canvas=React.useRef<HTMLCanvasElement>(null);
 React.useEffect(()=>{
  const target=canvas.current!,gl=target.getContext('webgl2',{alpha:false});if(!gl){onError?.();return;}
  const shader=(type:number,source:string)=>{const s=gl.createShader(type)!;gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s)||'Shader failed');return s;};
  let cleanup=()=>{};
  try{
   const vertex=shader(gl.VERTEX_SHADER,`#version 300 es
   in vec2 point;out vec2 uv;void main(){uv=point*.5+.5;gl_Position=vec4(point,0,1);}`);
   const fragment=shader(gl.FRAGMENT_SHADER,`#version 300 es
   precision highp float;precision highp sampler3D;
   uniform sampler2D source;uniform sampler3D lut;uniform float size;uniform vec3 low;uniform vec3 high;uniform bool first;in vec2 uv;out vec4 result;
   vec3 at(ivec3 p){return texelFetch(lut,p,0).rgb;}
   void main(){vec3 c=texture(source,vec2(uv.x,first?1.-uv.y:uv.y)).rgb;vec3 p=clamp((c-low)/(high-low),0.,1.)*(size-1.);ivec3 i=ivec3(min(floor(p),vec3(size-2.)));vec3 f=p-vec3(i),a=at(i),b=at(i+ivec3(1));vec3 outc;
   if(f.r>=f.g){if(f.g>=f.b)outc=a+f.r*(at(i+ivec3(1,0,0))-a)+f.g*(at(i+ivec3(1,1,0))-at(i+ivec3(1,0,0)))+f.b*(b-at(i+ivec3(1,1,0)));
   else if(f.r>=f.b)outc=a+f.r*(at(i+ivec3(1,0,0))-a)+f.b*(at(i+ivec3(1,0,1))-at(i+ivec3(1,0,0)))+f.g*(b-at(i+ivec3(1,0,1)));
   else outc=a+f.b*(at(i+ivec3(0,0,1))-a)+f.r*(at(i+ivec3(1,0,1))-at(i+ivec3(0,0,1)))+f.g*(b-at(i+ivec3(1,0,1)));}
   else{if(f.b>=f.g)outc=a+f.b*(at(i+ivec3(0,0,1))-a)+f.g*(at(i+ivec3(0,1,1))-at(i+ivec3(0,0,1)))+f.r*(b-at(i+ivec3(0,1,1)));
   else if(f.b>=f.r)outc=a+f.g*(at(i+ivec3(0,1,0))-a)+f.b*(at(i+ivec3(0,1,1))-at(i+ivec3(0,1,0)))+f.r*(b-at(i+ivec3(0,1,1)));
   else outc=a+f.g*(at(i+ivec3(0,1,0))-a)+f.r*(at(i+ivec3(1,1,0))-at(i+ivec3(0,1,0)))+f.b*(b-at(i+ivec3(1,1,0)));}result=vec4(outc,1);}`);
   const program=gl.createProgram()!;gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('Color preview unavailable');gl.useProgram(program);
   const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);const point=gl.getAttribLocation(program,'point');gl.enableVertexAttribArray(point);gl.vertexAttribPointer(point,2,gl.FLOAT,false,0,0);
   const texture=()=>{const t=gl.createTexture()!;gl.bindTexture(gl.TEXTURE_2D,t);for(const p of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,p,gl.LINEAR);for(const p of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T])gl.texParameteri(gl.TEXTURE_2D,p,gl.CLAMP_TO_EDGE);return t;};
   const input=texture(),outputs=[texture(),texture()],framebuffers=outputs.map(t=>{const f=gl.createFramebuffer()!;gl.bindFramebuffer(gl.FRAMEBUFFER,f);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t,0);return f;});
   const cubes=luts.map((row:any)=>{const t=gl.createTexture()!;gl.bindTexture(gl.TEXTURE_3D,t);gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texImage3D(gl.TEXTURE_3D,0,gl.RGB32F,row.size,row.size,row.size,0,gl.RGB,gl.FLOAT,new Float32Array(row.values));return t;});
   let raf:number,disposed=false,width=0,height=0,lastTime=-1;
   const draw=()=>{if(disposed)return;const v=video.current;if(v?.readyState>=2&&(v.currentTime!==lastTime||v.videoWidth!==width||v.videoHeight!==height)){lastTime=v.currentTime;if(v.videoWidth!==width||v.videoHeight!==height){width=target.width=v.videoWidth;height=target.height=v.videoHeight;for(const t of outputs){gl.bindTexture(gl.TEXTURE_2D,t);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);}}gl.viewport(0,0,width,height);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,input);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,v);
    luts.forEach((row:any,index:number)=>{gl.bindFramebuffer(gl.FRAMEBUFFER,index===luts.length-1?null:framebuffers[index%2]);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,index===0?input:outputs[(index-1)%2]);gl.uniform1i(gl.getUniformLocation(program,'source'),0);gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_3D,cubes[index]);gl.uniform1i(gl.getUniformLocation(program,'lut'),1);gl.uniform1f(gl.getUniformLocation(program,'size'),row.size);gl.uniform3fv(gl.getUniformLocation(program,'low'),row.min);gl.uniform3fv(gl.getUniformLocation(program,'high'),row.max);gl.uniform1i(gl.getUniformLocation(program,'first'),index===0?1:0);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);});
   }raf=requestAnimationFrame(draw);};draw();
   cleanup=()=>{disposed=true;cancelAnimationFrame(raf);for(const t of [input,...outputs,...cubes])gl.deleteTexture(t);framebuffers.forEach(f=>gl.deleteFramebuffer(f));gl.deleteBuffer(buffer);gl.deleteProgram(program);gl.deleteShader(vertex);gl.deleteShader(fragment);};
  }catch{onError?.();}
  return cleanup;
 },[luts.map((row:any)=>row.hash).join(':')]);
 return <canvas ref={canvas} className="live-composition-lut" style={style}/>;
}
