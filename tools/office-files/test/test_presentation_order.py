"""The presentation reader returns slides in the order the deck DECLARES, never file-name order, over a deck built here."""
import io
import json
import pathlib
import runpy
import zipfile

decoder = runpy.run_path(str(pathlib.Path(__file__).resolve().parent.parent / 'do-work' / 'decode-office-open-xml.py'))
P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
PKG = 'http://schemas.openxmlformats.org/package/2006/relationships'


def slide(text):
    return ('<p:sld xmlns:p="%s" xmlns:a="%s"><a:p><a:r><a:t>%s</a:t></a:r></a:p></p:sld>' % (P, A, text)).encode()


buffer = io.BytesIO()
with zipfile.ZipFile(buffer, 'w') as archive:
    archive.writestr('ppt/slides/slide2.xml', slide('Second file, shown first'))
    archive.writestr('ppt/slides/slide10.xml', slide('Tenth file, shown second'))
    archive.writestr('ppt/slides/slide1.xml', slide('First file, shown last'))
    archive.writestr('ppt/_rels/presentation.xml.rels', (
        '<Relationships xmlns="%s">'
        '<Relationship Id="rId1" Target="slides/slide2.xml"/>'
        '<Relationship Id="rId2" Target="slides/slide10.xml"/>'
        '<Relationship Id="rId3" Target="slides/slide1.xml"/></Relationships>' % PKG).encode())
    archive.writestr('ppt/presentation.xml', (
        '<p:presentation xmlns:p="%s" xmlns:r="%s"><p:sldIdLst>'
        '<p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId3"/>'
        '</p:sldIdLst></p:presentation>' % (P, R)).encode())
with zipfile.ZipFile(buffer) as archive:
    result = decoder['_decode_presentation'](archive)
assert result['kind'] == 'presentation'
assert [s['paragraphs'] for s in result['slides']] == [['Second file, shown first'], ['Tenth file, shown second'], ['First file, shown last']], result
assert [s['part'] for s in result['slides']] == ['ppt/slides/slide2.xml', 'ppt/slides/slide10.xml', 'ppt/slides/slide1.xml']
print(json.dumps({'ok': True, 'cases': 3}))
