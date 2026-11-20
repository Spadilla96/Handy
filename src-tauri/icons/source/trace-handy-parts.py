import numpy as np, json
from PIL import Image
from scipy import ndimage as ndi
import potrace
D='C:/Users/spadilla/Downloads/'
def load(n): return np.array(Image.open(D+n).convert('RGB')).astype(int)
a=load('Logotipo Handy con micrófono y ondas rojas.png'); b=load('Logo de Micrófono Espiral Minimalista.png')
def dark(im): return (im[...,0]<110)&(im[...,1]<110)&(im[...,2]<110)
def red(im): return (im[...,0]>140)&(im[...,1]<90)&(im[...,2]<90)
S=4
def smooth_trace(mask, sigma=2.2):
    # crop-free: upsample, blur, threshold -> smooth silhouette
    img=Image.fromarray((mask*255).astype(np.uint8)).resize((mask.shape[1]*S,mask.shape[0]*S),Image.BICUBIC)
    f=ndi.gaussian_filter(np.array(img).astype(float),sigma*S/2)
    bm=f>127
    bmp=potrace.Bitmap(~bm)
    plist=bmp.trace(turdsize=50,turnpolicy=potrace.POTRACE_TURNPOLICY_MINORITY,alphamax=1.0,opticurve=True,opttolerance=0.4)
    out=[]
    for c in plist:
        sp=c.start_point
        d=f"M{sp.x/S:.2f} {sp.y/S:.2f}"
        for seg in c.segments:
            if seg.is_corner:
                d+=f"L{seg.c.x/S:.2f} {seg.c.y/S:.2f}L{seg.end_point.x/S:.2f} {seg.end_point.y/S:.2f}"
            else:
                d+=f"C{seg.c1.x/S:.2f} {seg.c1.y/S:.2f} {seg.c2.x/S:.2f} {seg.c2.y/S:.2f} {seg.end_point.x/S:.2f} {seg.end_point.y/S:.2f}"
        out.append(d+"Z")
    return "".join(out)
lab,n=ndi.label(dark(b))
comps={}
for i in range(1,n+1):
    m=lab==i
    ys,xs=np.where(m)
    comps['head' if xs.min()>700 else 'shell']=smooth_trace(m)
lab,n=ndi.label(red(a))
sparks=[]
for i in range(1,n+1):
    m=lab==i
    ys,xs=np.where(m)
    if xs.min()>900: sparks.append(smooth_trace(m))
comps['sparks']=sparks
json.dump(comps,open('parts.json','w'))
print({k:(len(v) if isinstance(v,str) else [len(x) for x in v]) for k,v in comps.items()})
