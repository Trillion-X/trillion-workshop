import json,sys
for t in json.load(open(sys.argv[1]))["things"]:
	a = t.get("address", "")
	if "workflow-action" in a:
		print(a)
