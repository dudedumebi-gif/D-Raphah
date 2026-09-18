from PIL import Image, ImageDraw, ImageFont
import os, math
W,H,FPS,SECONDS=1280,720,30,12
out='/tmp/raphah-frames'; os.makedirs(out,exist_ok=True)
font='/usr/local/lib/code-server-0.0.84/lib/vscode/node_modules/.pnpm/katex@0.16.47/node_modules/katex/dist/fonts/KaTeX_SansSerif-Regular.ttf'; bold='/usr/local/lib/code-server-0.0.84/lib/vscode/node_modules/.pnpm/katex@0.16.47/node_modules/katex/dist/fonts/KaTeX_SansSerif-Bold.ttf'
def ease(x): return 1-(1-x)**3
for i in range(FPS*SECONDS):
    t=i/FPS; im=Image.new('RGB',(W,H),'#12232b'); d=ImageDraw.Draw(im)
    for x in range(0,W,42): d.line((x,0,x,H),fill='#29434a',width=1)
    for y in range(0,H,42): d.line((0,y,W,y),fill='#29434a',width=1)
    d.text((68,56),'raphah',font=ImageFont.truetype(bold,24),fill='#c5f36a')
    d.text((68,112),'PLATFORM STUDIO',font=ImageFont.truetype(font,18),fill='#c5f36a')
    a=ease(max(0,min(1,(t-0.5)/1.2)))
    d.text((68,178),'Make the work',font=ImageFont.truetype(bold,72),fill='#f6fbf4')
    d.text((68,258),'make sense.',font=ImageFont.truetype(bold,72),fill='#c5f36a')
    if t>1.5: d.text((72,382),'Clear decisions. Aligned delivery.',font=ImageFont.truetype(font,22),fill='#b5c9c5')
    if t>2.2: d.text((72,414),'Work clients can trust.',font=ImageFont.truetype(font,22),fill='#b5c9c5')
    if t>3.0: d.rounded_rectangle((68,494,310,550),radius=5,fill='#c5f36a'); d.text((92,512),'See the platform  ->',font=ImageFont.truetype(bold,19),fill='#12232b')
    x=820+int(18*math.sin(t*1.3)); y=110
    d.rounded_rectangle((x,y,x+360,y+430),radius=12,fill='#f6f8f4',outline='#46636a',width=3)
    d.rectangle((x,y,x+360,y+38),fill='#e4ebe5'); d.ellipse((x+22,y+15,x+30,y+23),fill='#ef8070'); d.ellipse((x+36,y+15,x+44,y+23),fill='#c5f36a')
    d.text((x+30,y+66),'OPPORTUNITY COMMAND CENTER',font=ImageFont.truetype(bold,13),fill='#496064')
    d.text((x+30,y+98),'Make the next move clear.',font=ImageFont.truetype(bold,23),fill='#12232b')
    d.text((x+30,y+170),'24',font=ImageFont.truetype(bold,38),fill='#12232b'); d.text((x+30,y+212),'active signals',font=ImageFont.truetype(font,13),fill='#789093')
    d.text((x+165,y+170),'68%',font=ImageFont.truetype(bold,38),fill='#ef8070'); d.text((x+165,y+212),'qualified',font=ImageFont.truetype(font,13),fill='#789093')
    d.line((x+30,y+290,x+315,y+290),fill='#c5f36a',width=5)
    im.save(f'{out}/frame-{i+1:04d}.png')
print(out)
