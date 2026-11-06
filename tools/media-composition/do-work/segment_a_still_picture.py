import sys
from rembg import remove, new_session
from PIL import Image
model=sys.argv[1]; s=new_session(model)
for src in sys.argv[2:]:
    im=Image.open(src).convert('RGB')
    m=remove(im,session=s,only_mask=True,post_process_mask=False)
    m.save(src.replace('.png',f'.mask-{model}.png'))
    print('ok',src,flush=True)
