/* Draft v2: independent star drift, warm junctions and a GPU fluid wake.
 * Only decorative canvases are added. Card content and input defaults stay intact.
 */
(() => {
  'use strict';
  const canvas=document.getElementById('bg-anim'), card=document.querySelector('.main-card');
  if(!canvas || !card || canvas.dataset.starfieldMounted) return;
  const ctx=canvas.getContext('2d'); if(!ctx) return;
  canvas.dataset.starfieldMounted='true'; canvas.setAttribute('aria-hidden','true');
  const preview=new URLSearchParams(location.search).has('preview');
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const coarse=matchMedia('(pointer: coarse)');
  const smokeCanvas=document.createElement('canvas');
  smokeCanvas.id='cursor-smoke'; smokeCanvas.setAttribute('aria-hidden','true');
  smokeCanvas.style.cssText='position:fixed;inset:0;width:100%;height:100%;z-index:0;pointer-events:none';
  canvas.before(smokeCanvas);
  let smoke=null, contextLost=false;
  function initSmoke() {
    try { smoke=window.createCardSmoke?.(smokeCanvas)||null; }
    catch(error) { if(preview) canvas.dataset.smokeError=error.message; smoke=null; }
    if(preview) canvas.dataset.smoke=smoke?'webgl2':'canvas-fallback';
  }
  initSmoke();
  const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
  let seed=78291;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  let w=1,h=1,mobile=false,dirty=true,resizePending=false,raf=0,last=0,time=0;
  let rect={left:0,right:0,top:0,bottom:0,radius:24};
  let target=null,pointer=null,demoStart=0,lastInk=-20,frame=0,nextSpark=.8,graphAt=-1;
  let samples=0,smokeTicks=0,statsAt=0,frameCost=0,inkVisible=false;
  const frameGaps=[];
  const stars=[],edges=new Map(),puffs=[];
  const maxStars=230,degree=3;
  const neighbors=new Int16Array(maxStars*degree),distances=new Float32Array(maxStars*degree);
  const active=new Set();
  // Same color range and 26-move cadence as the CodePen reference.
  const randomSmokeColor=()=>[Math.random()+.2,Math.random()+.2,Math.random()+.2];
  let smokeColor=randomSmokeColor(),colorMoves=0;
  function readBoundary() {
    const box=card.getBoundingClientRect();
    rect={left:box.left,right:box.right,top:box.top,bottom:box.bottom,radius:parseFloat(getComputedStyle(card).borderTopLeftRadius)||24};
    smoke?.boundary(rect); dirty=false;
  }
  function inCard(x,y,padding=3) {
    const radius=rect.radius+padding, cx=(rect.left+rect.right)/2,cy=(rect.top+rect.bottom)/2;
    const qx=Math.abs(x-cx)-(rect.right-rect.left)/2-padding+radius;
    const qy=Math.abs(y-cy)-(rect.bottom-rect.top)/2-padding+radius;
    return Math.hypot(Math.max(qx,0),Math.max(qy,0))+Math.min(Math.max(qx,qy),0)<radius;
  }
  function resize() {
    const oldMobile=mobile;
    w=document.documentElement.clientWidth || innerWidth; h=innerHeight;
    mobile=coarse.matches || w<=600;
    const dpr=Math.min(devicePixelRatio||1,2);
    canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);
    try {smoke?.resize(w,h,mobile);}
    catch(error){smoke=null;if(preview){canvas.dataset.smoke='canvas-fallback';canvas.dataset.smokeError=error.message;}}
    readBoundary();
    const count=mobile?94:230;
    if(stars.length!==count || oldMobile!==mobile) {
      stars.length=0; edges.clear(); seed=78291;
      for(let i=0;i<count;i++) {
        const depth=random(), side=random();
        stars.push({nx:random(),ny:random(),lane:side<(mobile?.48:.32)?(i%2?-1:1):0,
          vx:(random()-.5)*14,vy:-(10+random()*17),depth,r:.45+depth*depth*1.8,
          alpha:.42+random()*.4,phase:random()*Math.PI*2,ox:0,oy:0,vxOffset:0,vyOffset:0,
          x:0,y:0,joint:0,spark:-10,cooldown:0,connected:0});
      }
    }
    target=null;pointer=null;graphAt=-1;resizePending=false;
  }
  function limits(star) {
    if(star.lane<0) return [2,Math.max(4,rect.left-4)];
    if(star.lane>0) return [Math.min(w-4,rect.right+4),w-2];
    return [0,w];
  }
  function moveStars(dt) {
    for(const star of stars) {
      const [left,right]=limits(star), span=Math.max(2,right-left);
      star.nx+=star.vx*dt*(mobile && star.lane?.22:1)/span;
      if(star.nx<0 || star.nx>1){star.vx=star.nx<0?Math.abs(star.vx):-Math.abs(star.vx);star.nx=clamp(star.nx,0,1);}
      star.ny=(star.ny+star.vy*dt/h+1)%1;
      const bx=left+star.nx*span,by=star.ny*h;
      let fx=0,fy=0;
      if(pointer && !reduced.matches) {
        const dx=bx+star.ox-pointer.x,dy=by+star.oy-pointer.y,d=Math.hypot(dx,dy);
        if(d<115){const f=310*(1-d/115)**2;fx=dx/Math.max(d,1)*f;fy=dy/Math.max(d,1)*f;}
      }
      // Damped offsets are separate from the uninterrupted background drift.
      star.vxOffset=(star.vxOffset+(fx-star.ox*7)*dt)*Math.exp(-5*dt);
      star.vyOffset=(star.vyOffset+(fy-star.oy*7)*dt)*Math.exp(-5*dt);
      star.ox=clamp(star.ox+star.vxOffset*dt,-65,65);star.oy=clamp(star.oy+star.vyOffset*dt,-65,65);
      star.x=star.lane?clamp(bx+star.ox,left,right):bx+star.ox;
      star.y=by+star.oy;
    }
  }
  function offer(i,j,d) {
    const offset=i*degree;
    for(let k=0;k<degree;k++) if(d<distances[offset+k]) {
      for(let n=degree-1;n>k;n--){distances[offset+n]=distances[offset+n-1];neighbors[offset+n]=neighbors[offset+n-1];}
      distances[offset+k]=d;neighbors[offset+k]=j;break;
    }
  }
  function graph() {
    if(time-graphAt<.12) return;graphAt=time;neighbors.fill(-1);distances.fill(Infinity);active.clear();
    const reach=mobile?86:115;
    for(let i=0;i<stars.length;i++) for(let j=i+1;j<stars.length;j++) {
      const a=stars[i],b=stars[j],d=(a.x-b.x)**2+(a.y-b.y)**2,key=i*maxStars+j;
      if(d>reach*reach || inCard(a.x,a.y,0) || inCard(b.x,b.y,0)) continue;
      const score=d*(edges.has(key)?.77:1);offer(i,j,score);offer(j,i,score);
    }
    for(let i=0;i<stars.length;i++) for(let k=0;k<degree;k++) {
      const j=neighbors[i*degree+k]; if(j<=i)continue;
      for(let n=0;n<degree;n++) if(neighbors[j*degree+n]===i) {
        const key=i*maxStars+j;active.add(key);
        if(!edges.has(key)) edges.set(key,{i,j,light:0});break;
      }
    }
  }
  function drawLinks(dt) {
    graph();for(const s of stars){s.joint=0;s.connected=0;}
    let candidate=null,score=-1;
    for(const [key,e] of edges) {
      const a=stars[e.i],b=stars[e.j],distance=Math.hypot(a.x-b.x,a.y-b.y);
      const reach=mobile?94:125,fade=clamp((reach-distance)/(reach*.56),0,1);
      let focus=mobile?.86:.48;
      if(pointer) focus=Math.max(focus,clamp(1-Math.min(Math.hypot(a.x-pointer.x,a.y-pointer.y),Math.hypot(b.x-pointer.x,b.y-pointer.y))/290,0,1));
      const goal=active.has(key)?fade*focus:0,old=e.light;
      e.light+=(goal-e.light)*(1-Math.exp(-(goal>old?5:3.4)*dt));
      if(e.light<.004 && !active.has(key)){edges.delete(key);continue;}
      if(e.light<.01)continue;
      a.joint=Math.max(a.joint,e.light);b.joint=Math.max(b.joint,e.light);a.connected++;b.connected++;
      ctx.strokeStyle=`rgba(98,168,244,${e.light*.32})`;ctx.lineWidth=.65;
      ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
      if(old<.20 && e.light>=.20) for(const s of [a,b]) {
        const weight=e.light+s.depth*.2;
        if(s.cooldown<time && weight>score){candidate=s;score=weight;}
      }
    }
    if(candidate && time>nextSpark && !reduced.matches) {
      candidate.spark=time;candidate.cooldown=time+3.8;nextSpark=time+.65;
    }
  }
  function drawPuffs(dt) {
    for(let i=puffs.length-1;i>=0;i--) {
      const p=puffs[i];p.life-=dt;if(p.life<=0){puffs.splice(i,1);continue;}
      const nx=p.x+p.vx*dt,ny=p.y+p.vy*dt;
      if(inCard(nx,ny,p.r*.3)) {p.vx*=.2;p.vy+=Math.sign(p.y-(rect.top+rect.bottom)/2)*18*dt;}
      else {p.x=nx;p.y=ny;}
      p.vx*=Math.exp(-1.2*dt);p.vy*=Math.exp(-1.2*dt);p.r+=7*dt;
      const g=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,p.r);
      g.addColorStop(0,`rgba(${p.color},${p.life*.095})`);g.addColorStop(1,`rgba(${p.color},0)`);
      ctx.fillStyle=g;ctx.fillRect(p.x-p.r,p.y-p.r,p.r*2,p.r*2);
    }
  }
  function draw(dt) {
    ctx.clearRect(0,0,w,h);
    if(!smoke) drawPuffs(dt);
    drawLinks(dt);
    for(const s of stars) {
      if(inCard(s.x,s.y,0))continue;
      const twinkle=.84+Math.sin(time*.8+s.phase)*.16;
      if(s.depth>.84){const g=ctx.createRadialGradient(s.x,s.y,0,s.x,s.y,s.r*5);g.addColorStop(0,`rgba(88,170,255,${s.alpha*.15})`);g.addColorStop(1,'rgba(88,170,255,0)');ctx.fillStyle=g;ctx.fillRect(s.x-s.r*5,s.y-s.r*5,s.r*10,s.r*10);}
      ctx.fillStyle=`rgba(95,174,255,${s.alpha*twinkle})`;ctx.beginPath();ctx.arc(s.x,s.y,s.r,0,Math.PI*2);ctx.fill();
      const age=time-s.spark,pulse=age>=0 && age<1.2 && !reduced.matches?Math.sin(Math.min(age/.17,1)*Math.PI/2)*(1-age/1.2)**2:0;
      const joint=s.joint*clamp(s.connected/2,.4,1);
      if(joint>.08 || pulse>0) {
        const r=5+joint*3+pulse*9,g=ctx.createRadialGradient(s.x,s.y,0,s.x,s.y,r);
        g.addColorStop(0,`rgba(255,233,180,${joint*.3+pulse*.6})`);
        g.addColorStop(.28,`rgba(248,196,115,${joint*.13+pulse*.29})`);g.addColorStop(1,'rgba(248,196,115,0)');
        ctx.fillStyle=g;ctx.fillRect(s.x-r,s.y-r,r*2,r*2);
        ctx.fillStyle=`rgba(255,246,215,${joint*.65+pulse*.34})`;ctx.beginPath();ctx.arc(s.x,s.y,.7+joint*.65+pulse*.8,0,Math.PI*2);ctx.fill();
        if(pulse>.12){const ray=2+pulse*6;ctx.strokeStyle=`rgba(255,233,182,${pulse*.62})`;ctx.lineWidth=.65;ctx.beginPath();ctx.moveTo(s.x-ray,s.y);ctx.lineTo(s.x+ray,s.y);ctx.moveTo(s.x,s.y-ray);ctx.lineTo(s.x,s.y+ray);ctx.stroke();}
      }
    }
  }
  function point(x,y) {
    if(inCard(x,y)){target=null;pointer=null;return;}
    if(++colorMoves>25){smokeColor=randomSmokeColor();colorMoves=0;}
    target={x:clamp(x,0,w),y:clamp(y,0,h)};samples++;
  }
  function tick(now) {
    raf=0;if(document.hidden)return;
    const begin=performance.now(),gap=now-(last||now-16.67),dt=clamp(gap/1000,.001,.05);last=now;
    if(preview){frameGaps.push(gap);if(frameGaps.length>120)frameGaps.shift();}
    if(resizePending)resize();else if(dirty)readBoundary();
    const speed=reduced.matches?.22:1;time+=dt*speed;
    if(demoStart) {
      const elapsed=(now-demoStart)/1000;
      if(elapsed>10){demoStart=0;target=null;pointer=null;}
      else {
        const available=Math.max(8,rect.left-8);
        point(available*(.54+.45*Math.sin(elapsed*1.5)),h*(.5+.31*Math.sin(elapsed*1.1)));
      }
    }
    if(target && !reduced.matches) {
      if(!pointer)pointer={...target};
      const before={...pointer},easing=1-Math.exp(-dt/0.026);
      pointer.x+=(target.x-pointer.x)*easing;pointer.y+=(target.y-pointer.y)*easing;
      const distance=Math.hypot(pointer.x-before.x,pointer.y-before.y);
      if(distance>.08 && !inCard(pointer.x,pointer.y)) {
        if(smoke && !contextLost)smoke.splat(before,pointer,dt,smokeColor);
        else if(puffs.length<100)puffs.push({x:pointer.x,y:pointer.y,vx:(pointer.x-before.x)/dt*.16,vy:(pointer.y-before.y)/dt*.16,r:12,life:1.7,
          color:smokeColor.map(channel=>Math.round(channel/Math.max(...smokeColor)*255)).join(',')});
        lastInk=time;
      }
    }
    const steps=Math.max(1,Math.ceil(dt/(1/60)));
    for(let i=0;i<steps;i++)moveStars(dt*speed/steps);
    if(smoke && !contextLost && !reduced.matches && time-lastInk<6){smoke.step(dt);smokeTicks++;inkVisible=true;}
    else if(inkVisible){smoke?.clear();inkVisible=false;}
    draw(dt*speed);frame++;
    frameCost=frameCost*.94+(performance.now()-begin)*.06;
    if(preview && now-statsAt>500){
      canvas.dataset.frames=String(frame);canvas.dataset.starProbe=`${stars[1].x.toFixed(2)},${stars[1].y.toFixed(2)}`;
      canvas.dataset.frameCost=frameCost.toFixed(2);canvas.dataset.pointerSamples=String(samples);
      canvas.dataset.smokeTicks=String(smokeTicks);canvas.dataset.mobile=String(mobile);canvas.dataset.reduced=String(reduced.matches);
      canvas.dataset.edges=String(edges.size);statsAt=now;
      const sorted=frameGaps.slice().sort((a,b)=>a-b);
      canvas.dataset.frameIntervalP95=sorted[Math.floor((sorted.length-1)*.95)].toFixed(1);
    }
    raf=requestAnimationFrame(tick);
  }
  function start(){if(!raf && !document.hidden){last=0;raf=requestAnimationFrame(tick);}}
  function resetPointer(){target=null;pointer=null;demoStart=0;}
  function input(event){demoStart=0;point(event.clientX,event.clientY);}
  addEventListener('pointermove',input,{passive:true});
  addEventListener('pointerdown',event=>{if(event.pointerType==='touch')input(event);},{passive:true});
  addEventListener('pointerup',event=>{if(event.pointerType!=='mouse')resetPointer();},{passive:true});
  addEventListener('pointercancel',resetPointer,{passive:true});
  document.documentElement.addEventListener('pointerleave',resetPointer,{passive:true});
  if(!window.PointerEvent)addEventListener('touchmove',event=>{const t=event.touches[0];if(t)input(t);},{passive:true});
  addEventListener('blur',resetPointer);
  addEventListener('resize',()=>{resizePending=true;},{passive:true});
  addEventListener('scroll',()=>{dirty=true;resetPointer();},{passive:true});
  if(window.ResizeObserver)new ResizeObserver(()=>{dirty=true;}).observe(card);
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){cancelAnimationFrame(raf);raf=0;resetPointer();}
    else {dirty=true;start();}
  });
  const motionChange=()=>{resetPointer();smoke?.clear();start();};
  if(reduced.addEventListener)reduced.addEventListener('change',motionChange);else reduced.addListener(motionChange);
  smokeCanvas.addEventListener('webglcontextlost',event=>{event.preventDefault();contextLost=true;smoke=null;if(preview)canvas.dataset.smoke='canvas-fallback';});
  smokeCanvas.addEventListener('webglcontextrestored',()=>{contextLost=false;initSmoke();resizePending=true;});
  if(preview)addEventListener('message',event=>{
    if(event.origin!==location.origin || event.source!==parent)return;
    if(event.data?.type==='preview:demo'){resetPointer();demoStart=performance.now();start();}
  });
  resize();moveStars(0);draw(.016);start();
})();
