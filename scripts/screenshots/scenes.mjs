// Scene definitions for capture.mjs. A scene's `nodes` are placed at `at: [x, y]` (graph units); `edges` are
// 'nodeKey.port' pairs; a param value '@asset:scene' is replaced by the id of the imported test image.

const SCENE = 'test-assets/scene-1920x1080.png';

/** A 4 s mono 16-bit WAV with a kick and hi-hat pattern, so the timeline shows a real waveform. Generated, no media used. */
function drumLoopWav() {
  const sr = 22050, secs = 4, n = sr * secs, pcm = new Int16Array(n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let beat = 0; beat < 8; beat++) {
    const t0 = beat * 0.5;
    if (beat % 2 === 0) for (let i = 0; i < sr * 0.25; i++) { const t = i / sr, f = 130 * Math.exp(-t * 14) + 45; pcm[Math.floor(t0 * sr) + i] += Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 9) * 20000; }
    for (let i = 0; i < sr * 0.05; i++) { const k = Math.floor((t0 + 0.25) * sr) + i; if (k < n) pcm[k] += rnd() * Math.exp(-i / (sr * 0.012)) * 7000; }
  }
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, pcm[i])), 44 + i * 2);
  return buf;
}

/** A looping four-bar-ish MIDI phrase (A minor arpeggio), notes in seconds. */
function phrase() {
  const notes = [];
  const seq = [57, 60, 64, 69, 64, 60, 64, 67, 55, 59, 62, 67, 62, 59, 64, 69];
  seq.forEach((note, i) => notes.push({ t: i * 0.25, d: 0.22, note, vel: 0.6 + (i % 4 === 0 ? 0.25 : 0) }));
  return notes;
}

export const scenes = [
  {
    id: 'hero',
    async run(k) {
      const scene = await k.importFile(SCENE, 'image/png');
      const ids = await k.openGraph(
        {
          name: 'Pixel-art pipeline',
          nodes: {
            src: { type: 'media-in', at: [0, 0], params: { assets: '@asset:scene' } },
            pix: { type: 'pixelate', at: [300, 0], params: { value: 135 } },
            pal: { type: 'palette', at: [300, 320], params: { builtin: 'endesga-32' } },
            dit: { type: 'dither', at: [600, 0], params: { algorithm: 'bayer-4', strength: 0.6 } },
            crt: { type: 'crt-display', at: [900, 0], params: { preset: 'consumer' } },
            out: { type: 'image-out', at: [1200, 0], params: { name: 'hero' } },
          },
          edges: [
            ['src.image', 'pix.image'],
            ['pix.image', 'dit.image'],
            ['pal.palette', 'dit.palette'],
            ['dit.image', 'crt.image'],
            ['crt.image', 'out.image'],
          ],
        },
        { scene },
      );
      await k.frameAll();
      await k.selectNode(ids.crt);
      await k.settle();
      await k.shot('01-hero.png');
    },
  },

  {
    id: 'generate',
    async run(k) {
      const X = (c) => c * 260, Y = (r) => r * 290;
      const ids = await k.openGraph({
        name: 'Two 3D objects, two cameras',
        ui: { split: 0.36, leftOpen: false },
        nodes: {
          cam1: { type: 'camera', at: [X(0), Y(0)], params: { projection: 'perspective', rig: 'threeQuarter' } },
          cam2: { type: 'camera', at: [X(0), Y(1)], params: { projection: 'isometric' } },
          anim: { type: 'animate', at: [X(1), Y(0)], params: { wave: 'saw-up', from: 0, to: 360 } },
          keys: { type: 'keyframes', at: [X(1), Y(1)], params: { scale: 70, offset: 10, curve: { keys: [{ t: 0, v: 0, interp: 'smooth' }, { t: 0.3, v: 1, interp: 'smooth' }, { t: 0.55, v: 0.35, interp: 'smooth' }, { t: 0.8, v: 0.8, interp: 'smooth' }, { t: 1, v: 0, interp: 'smooth' }] } } },
          o1: { type: 'object-3d', at: [X(2), Y(0)], params: { shape: 'torus', posX: -1.4, objectScale: 0.9 } },
          o2: { type: 'object-3d', at: [X(2), Y(1)], params: { shape: 'cube', posX: 1.4, objectScale: 0.9, cel: true } },
          m1: { type: 'merge', at: [X(3), Y(0)] },
          bg: { type: 'gradient', at: [X(3), Y(1)], params: { kind: 'radial' } },
          m2: { type: 'merge', at: [X(4), Y(0)] },
          out: { type: 'image-out', at: [X(4), Y(1)], params: { name: 'generators' } },
        },
        edges: [
          ['cam1.camera', 'o1.camera'],
          ['cam2.camera', 'o2.camera'],
          ['anim.value', 'o1.rotY'],
          ['keys.value', 'o2.rotX'],
          ['bg.image', 'm1.background'],
          ['o1.image', 'm1.foreground'],
          ['m1.image', 'm2.background'],
          ['o2.image', 'm2.foreground'],
          ['m2.image', 'out.image'],
        ],
      });
      await k.frameAll();
      await k.selectNode(ids.keys);
      await k.js('window.__rsmpsIo.player.seek(1.1)');
      await k.settle();
      await k.clickSel('.rs-curve--lg');
      await k.sleep(600);
      await k.shot('02-generate.png');
    },
  },

  {
    id: 'audio',
    async run(k) {
      const loop = await k.importBytes('drum-loop.wav', 'audio/wav', drumLoopWav());
      const X = (c) => c * 240;
      const clips = {
        version: 1,
        tracks: [
          { id: 'a1', name: 'Drums', kind: 'audio', gain: 0, pan: 0, mute: false, solo: false },
          { id: 'm1', name: 'Synth', kind: 'midi', gain: 0, pan: 0, mute: false, solo: false },
        ],
        clips: [
          { id: 'c1', track: 'a1', start: 0, length: 4, offset: 0, loop: false, gain: 0, fadeIn: 0, fadeOut: 0, asset: loop, name: 'drum-loop' },
          { id: 'c2', track: 'm1', start: 0, length: 4, offset: 0, loop: true, srcLength: 4, gain: 0, fadeIn: 0, fadeOut: 0, name: 'arp', notes: phrase() },
        ],
      };
      const ids = await k.openGraph({
        name: 'Synth, timeline and sound-to-picture',
        ui: { split: 0.31, leftOpen: false },
        nodes: {
          kbd: { type: 'midi-keyboard', at: [X(0), 0], collapsed: true },
          tl: { type: 'audio-timeline', at: [X(1), 0], params: { clips } },
          syn: { type: 'synth', at: [X(2), 0], params: { wave1: 'saw', wave2: 'square', unison: 3, cutoff: 2400 } },
          rev: { type: 'reverb', at: [X(3), 0], params: { mix: 0.25 } },
          mix: { type: 'mixer', at: [X(4), 0], collapsed: true },
          out: { type: 'image-out', at: [X(8), 0], params: { name: 'sound-to-picture' } },
          aout: { type: 'audio-out', at: [X(5), 0], collapsed: true },
          lvl: { type: 'audio-level', at: [X(6), 0], params: { from: 20, to: 200 } },
          obj: { type: 'object-3d', at: [X(7), 0], params: { shape: 'cube', baseColor: [0.3, 0.8, 0.94, 1] } },
        },
        edges: [
          ['kbd.midi', 'tl.recordMidi'],
          ['tl.midi', 'syn.midi'],
          ['syn.audio', 'rev.audio'],
          ['rev.audio', 'mix.audio'],
          ['tl.audio', 'mix.audio'],
          ['mix.audio', 'aout.audio'],
          ['tl.audio', 'lvl.audio'],
          ['lvl.level', 'obj.rotY'],
          ['obj.image', 'out.image'],
        ],
      });
      await k.frameAll();
      await k.selectNode(ids.tl);
      await k.js('window.__rsmpsIo.player.seek(1.0)');
      await k.settle();
      await k.clickText('Open timeline');
      await k.sleep(800);
      await k.js("document.querySelector('.rs-tl').style.minHeight='150px';document.querySelector('.rs-tl').style.height='190px'");
      await k.clickSel('.rs-tl__head [role=spinbutton]');
      await k.sleep(300);
      await k.key('A', ['control']);
      await k.type('160');
      await k.key('Return');
      await k.sleep(1000);
      await k.shot('03-audio.png');
    },
  },

  {
    id: 'track',
    async run(k) {
      const scene = await k.importFile(SCENE, 'image/png');
      const X = (c) => c * 250, Y = (r) => r * 300;
      const ids = await k.openGraph(
        {
          name: 'Detect, track, mask',
          ui: { split: 0.44, leftOpen: false },
          nodes: {
            src: { type: 'media-in', at: [X(0), Y(0)], params: { assets: '@asset:scene' } },
            det: { type: 'detect-blobs', at: [X(1), Y(0)], params: { threshold: 0.86, minSize: 0.05, maxCount: 4 } },
            trk: { type: 'track', at: [X(2), Y(0)] },
            r2m: { type: 'regions-to-mask', at: [X(3), Y(0)], params: { shape: 'ellipse', feather: 10 } },
            fx: { type: 'halftone', at: [X(3.5), Y(1)], params: { mode: 'cmyk', dotSize: 7 } },
            ovl: { type: 'region-overlay', at: [X(4), Y(0)], params: { style: 'brackets', perId: true, showLabel: false } }, // labels off: see the report on region-overlay text
            out: { type: 'image-out', at: [X(5), Y(0)], params: { name: 'tracked' } },
          },
          edges: [
            ['src.image', 'det.image'],
            ['det.regions', 'trk.regions'],
            ['trk.regions', 'r2m.regions'],
            ['src.image', 'r2m.image'],
            ['src.image', 'fx.image'],
            ['r2m.mask', 'fx.mask'],
            ['fx.image', 'ovl.image'],
            ['trk.regions', 'ovl.regions'],
            ['ovl.image', 'out.image'],
          ],
        },
        { scene },
      );
      await k.frameAll();
      await k.selectNode(ids.det);
      await k.js('window.__rsmpsIo.player.seek(1.5)');
      await k.settle();
      await k.shot('04-track.png');
    },
  },

  {
    id: 'addmenu',
    async run(k) {
      const scene = await k.importFile(SCENE, 'image/png');
      const ids = await k.openGraph(
        {
          name: 'Add-node menu',
          ui: { split: 0.4 },
          nodes: {
            src: { type: 'media-in', at: [0, 0], params: { assets: '@asset:scene' } },
            pix: { type: 'pixelate', at: [300, 0], params: { value: 160 } },
            dit: { type: 'dither', at: [600, 0], params: { algorithm: 'atkinson', fallback: 'pico-8' } },
            out: { type: 'image-out', at: [900, 0], params: { name: 'menu' } },
          },
          edges: [['src.image', 'pix.image'], ['pix.image', 'dit.image'], ['dit.image', 'out.image']],
        },
        { scene },
      );
      await k.selectNode(ids.dit);
      await k.settle();
      await k.clickText('Add');
      await k.clickText('Pixel Art', '.rs-add__cat');
      await k.sleep(800);
      await k.shot('05-add-menu.png');
    },
  },

  {
    id: 'palette',
    async run(k) {
      const scene = await k.importFile(SCENE, 'image/png');
      const ids = await k.openGraph(
        {
          name: 'Palette Studio',
          nodes: {
            src: { type: 'media-in', at: [0, 0], params: { assets: '@asset:scene' } },
            pal: { type: 'palette', at: [300, 0], params: { source: 'extract', count: 12 } },
            dit: { type: 'dither', at: [600, 0], params: { algorithm: 'floyd-steinberg' } },
            out: { type: 'image-out', at: [900, 0], params: { name: 'palette' } },
          },
          edges: [['src.image', 'pal.image'], ['src.image', 'dit.image'], ['pal.palette', 'dit.palette'], ['dit.image', 'out.image']],
        },
        { scene },
      );
      await k.settle();
      await k.clickText('Palettes');
      await k.sleep(800);
      await k.clickText('From image');
      await k.sleep(800);
      await k.clickText('Extract palette');
      await k.sleep(500);
      await k.waitFor("![...document.querySelectorAll('button')].some((b) => b.textContent.includes('Extracting'))", 30000, 'extraction');
      await k.sleep(800);
      await k.shot('06-palette.png');
    },
  },

  {
    id: 'scan',
    async run(k) {
      // 1. A small spinning-cube animation, exported by the app's own exporter as printable PNG sheets.
      // 2. The sheets are "photographed": tilted, shrunk onto a table-coloured background, lightly noised.
      // 3. They are stored as the photos of a new Scan project; reloading makes the UI analyse and show them.
      const info = await k.js(`(async()=>{
        const io=window.__rsmpsIo; const G=await import('/src/engine/graph.ts');
        let g=G.createGraph('Print sheet');
        g={...g,project:{...g.project,width:480,height:480,fps:6,duration:2}};
        const bg=G.addNode(g,io.registry,'solid',{x:0,y:0},{color:[1,1,1,1]}); g=bg.graph;
        const cam=G.addNode(g,io.registry,'camera',{x:0,y:0},{projection:'perspective',rig:'threeQuarter'}); g=cam.graph;
        const o=G.addNode(g,io.registry,'object-3d',{x:0,y:0},{shape:'torus',spinY:1,objectScale:1.1,baseColor:[0.5,0.5,0.5,1]}); g=o.graph;
        const la=G.addNode(g,io.registry,'line-art',{x:0,y:0}); g=la.graph;
        const m=G.addNode(g,io.registry,'merge',{x:0,y:0}); g=m.graph;
        const out=G.addNode(g,io.registry,'image-out',{x:0,y:0},{kind:'print',printOutput:'png',printDpi:110,printPaper:'a4',printColumns:3,printRows:4,printFrameWidth:50,printGuideOpacity:90,name:'sheet'}); g=out.graph;
        g=G.connect(g,io.registry,{node:cam.node.id,port:'camera'},{node:o.node.id,port:'camera'});
        g=G.connect(g,io.registry,{node:bg.node.id,port:'image'},{node:m.node.id,port:'background'});
        g=G.connect(g,io.registry,{node:o.node.id,port:'image'},{node:m.node.id,port:'foreground'});
        g=G.connect(g,io.registry,{node:m.node.id,port:'image'},{node:la.node.id,port:'image'});
        g=G.connect(g,io.registry,{node:la.node.id,port:'image'},{node:out.node.id,port:'image'});
        const files=await io.exporter.run({graph:g,outputs:[],items:'current',item:0,zip:false});
        const pages=files.filter(f=>/\.png$/i.test(f.name));
        const photos=[];
        let i=0;
        for(const f of pages){
          const bmp=await createImageBitmap(f.blob);
          const W=Math.round(bmp.width*1.18),H=Math.round(bmp.height*1.1);
          const c=new OffscreenCanvas(W,H); const x=c.getContext('2d');
          x.fillStyle='#6f6a60'; x.fillRect(0,0,W,H);
          x.save(); x.translate(W/2,H/2); x.rotate((i%2?-1:1)*0.035); x.shadowColor='rgba(0,0,0,.45)'; x.shadowBlur=18; x.shadowOffsetY=6;
          x.fillStyle='#fff'; x.drawImage(bmp,-bmp.width/2,-bmp.height/2); x.restore();
          const id=x.getImageData(0,0,W,H); let s=12345+i;
          for(let p=0;p<id.data.length;p+=4){ s=(s*1103515245+12345)&0x7fffffff; const n=((s>>8)%13)-6; id.data[p]+=n;id.data[p+1]+=n;id.data[p+2]+=n; }
          x.putImageData(id,0,0);
          const blob=await c.convertToBlob({type:'image/jpeg',quality:0.9});
          photos.push({name:'photo-'+(++i)+'.jpg',blob});
        }
        const open=await io.projects.listOpen();
        const p=await io.projects.createScanProject('Scan: sheet of a spinning torus');
        for(const q of open) await io.projects.closeProject(q.id);
        await io.projects.setActive(p.id);
        io.projects.saveScanSession(p.id,{photos,manual:{},options:{}}); await io.projects.flush();
        const files2=photos.map((q)=>new File([q.blob],q.name,{type:q.blob.type}));
        const res=await io.scan.analyze(files2);
        await io.scan.attach(p.id,res,{name:'Scan: sheet of a spinning torus',fps:res.report.fps||6});
        try{localStorage.setItem('rsmps.ui.zoomHint','9')}catch{}
        return pages.map(f=>f.name+' '+f.blob.size).join(', ');
      })()`);
      console.log('  pages:', info);
      await k.win.webContents.reload();
      await k.waitFor('!!window.__rsmpsIo', 60000, 'io after reload');
      await k.sleep(6000);
      await k.shot('07a-scan-photos.png');
      await k.clickText('Clean up & export', 'button,[role=tab],a', { includes: true });
      await k.sleep(4000);
      await k.shot('07-scan.png');
    },
  },
];
