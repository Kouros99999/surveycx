# Renders web/img/og.png (1200x630): the results screenshot in a frame with the logo and a line of copy.
# Run after make-shots.js: python web/make-og.py
import os
from PIL import Image, ImageDraw, ImageFont

here = os.path.dirname(os.path.abspath(__file__))
W, H = 1200, 630
img = Image.new('RGB', (W, H), '#F3FAF9')
d = ImageDraw.Draw(img)
for y in range(H):
    t = y / H
    d.line([(0, y), (W, y)], fill=(int(243 + 12 * t), int(250 + 5 * t), int(249 + 6 * t)))

def font(size, bold=True):
    for name in (['segoeuib.ttf', 'arialbd.ttf'] if bold else ['segoeui.ttf', 'arial.ttf']):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()

# logo: the speech bubble on a teal tile, drawn directly (no PNG dependency)
d.rounded_rectangle([64, 56, 136, 128], radius=16, fill='#0F766E')
d.rounded_rectangle([80, 82, 120, 108], radius=10, fill='#FFFFFF')
d.polygon([(86, 106), (86, 118), (96, 108)], fill='#FFFFFF')
for x in (91, 100, 109):
    d.ellipse([x - 3, 92, x + 3, 98], fill='#0F766E')
d.text((152, 62), 'SurveyCX for Amazon Connect', font=font(40), fill='#14191F')
d.text((64, 176), 'Ask every customer', font=font(46), fill='#14191F')
d.text((64, 232), 'how it went. Act on', font=font(46), fill='#14191F')
d.text((64, 288), 'it the same day.', font=font(46), fill='#0F766E')
d.text((64, 384), 'Surveys on the IVR, in chat, by SMS', font=font(24, False), fill='#3D4650')
d.text((64, 416), 'and email. Results by agent, queue', font=font(24, False), fill='#3D4650')
d.text((64, 448), 'and driver. A Task on every low score.', font=font(24, False), fill='#3D4650')
d.rounded_rectangle([64, 500, 470, 556], radius=12, fill='#0F766E')
d.text((86, 513), '$0.10 per completed response', font=font(24), fill='#FFFFFF')

shot = Image.open(os.path.join(here, 'img', 'results.png')).convert('RGB')
sw = 540
sh = int(shot.height * sw / shot.width)
shot = shot.resize((sw, sh), Image.LANCZOS)
frame = Image.new('RGB', (sw + 16, min(sh, 470) + 16), '#E3E7EA')
frame.paste(shot.crop((0, 0, sw, min(sh, 470))), (8, 8))
img.paste(frame, (W - sw - 16 - 36, 160))
out = os.path.join(here, 'img', 'og.png')
img.save(out, optimize=True)
print('wrote', out, os.path.getsize(out) // 1024, 'KB')
