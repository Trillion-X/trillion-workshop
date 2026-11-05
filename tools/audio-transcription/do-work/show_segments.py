for s in d["segments"]:
    if float(sys.argv[2]) <= s["start"] <= float(sys.argv[3]):
        print(round(s["start"]), s["text"][:140])
