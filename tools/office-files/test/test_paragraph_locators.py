import io
import pathlib
import json
import runpy
import zipfile

decoder = runpy.run_path(str(pathlib.Path(__file__).resolve().parent.parent / 'do-work' / 'decode-office-open-xml.py'))
ns = decoder['NS_WORD']
xml = ('<w:document xmlns:w="' + ns + '"><w:body>'
       '<w:p><w:r><w:t>First</w:t></w:r></w:p><w:p/>'
       '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
       '<w:p><w:r><w:t>Third</w:t></w:r></w:p>'
       '</w:body></w:document>')
buffer = io.BytesIO()
with zipfile.ZipFile(buffer, 'w') as archive:
    archive.writestr('word/document.xml', xml)
with zipfile.ZipFile(buffer) as archive:
    blocks = decoder['_decode_document'](archive)['blocks']
assert [b['selector'] for b in blocks if b['type'] == 'paragraph'] == ['paragraph:1', 'paragraph:3']
assert [b['text'] for b in blocks if b['type'] == 'paragraph'] == ['First', 'Third']
assert blocks[1] == {'type': 'table', 'rows': [['Table']]}
print(json.dumps({'id': 'office-paragraph-locators', 'kind': 'test-result', 'passed': 3,
                  'checks': ['empty paragraph keeps ordinal', 'table does not shift paragraph ordinal', 'existing content preserved']}))
