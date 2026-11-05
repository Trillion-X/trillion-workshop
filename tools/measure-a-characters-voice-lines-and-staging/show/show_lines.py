if __name__ == '__main__':
    a = float(sys.argv[2]) if len(sys.argv) > 2 else 0
    b = float(sys.argv[3]) if len(sys.argv) > 3 else 1e9
    for t, d, x in events(sys.argv[1]):
        if a <= t <= b:
            print(f'{t:7.1f} {x}')
