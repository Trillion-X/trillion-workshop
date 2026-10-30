# syntax=docker/dockerfile:1
# The manifest-list digest selects a fixed linux/arm64 Python base when the
# existing container-engine owner builds with platform=linux/arm64.
FROM docker.io/library/python:3.12-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254 AS whisper-builder

ARG WHISPER_CPP_VERSION=1.8.3
ARG WHISPER_CPP_SHA256=870ba21409cdf66697dc4db15ebdb13bc67037d76c7cc63756c81471d8f1731a

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates cmake curl g++ make \
    && rm -rf /var/lib/apt/lists/*

RUN curl --fail --location --proto '=https' --tlsv1.2 \
      "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${WHISPER_CPP_VERSION}.tar.gz" \
      --output /tmp/whisper.cpp.tar.gz \
    && echo "${WHISPER_CPP_SHA256}  /tmp/whisper.cpp.tar.gz" | sha256sum --check --strict \
    && mkdir /tmp/whisper.cpp \
    && tar --extract --gzip --file /tmp/whisper.cpp.tar.gz --directory /tmp/whisper.cpp --strip-components=1 \
    && cmake -S /tmp/whisper.cpp -B /tmp/whisper.cpp/build \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_INSTALL_PREFIX=/opt/whisper \
      -DGGML_NATIVE=OFF \
      -DWHISPER_BUILD_EXAMPLES=ON \
      -DWHISPER_BUILD_SERVER=OFF \
      -DWHISPER_BUILD_TESTS=OFF \
    && cmake --build /tmp/whisper.cpp/build --config Release --target whisper-cli --parallel 2 \
    && mkdir -p /opt/whisper/bin /opt/whisper/lib \
    && cp /tmp/whisper.cpp/build/bin/whisper-cli /opt/whisper/bin/whisper-cli \
    && find /tmp/whisper.cpp/build -type f \
      \( -name 'libwhisper.so*' -o -name 'libggml.so*' -o -name 'libggml-base.so*' -o -name 'libggml-cpu.so*' \) \
      -exec cp -P '{}' /opt/whisper/lib/ \; \
    && test -x /opt/whisper/bin/whisper-cli \
    && test -f /opt/whisper/lib/libwhisper.so.1.8.3 \
    && test -f /opt/whisper/lib/libggml.so.0.9.5 \
    && test -f /opt/whisper/lib/libggml-base.so.0.9.5 \
    && test -f /opt/whisper/lib/libggml-cpu.so.0.9.5 \
    && ln -s libwhisper.so.1.8.3 /opt/whisper/lib/libwhisper.so.1 \
    && ln -s libggml.so.0.9.5 /opt/whisper/lib/libggml.so.0 \
    && ln -s libggml-base.so.0.9.5 /opt/whisper/lib/libggml-base.so.0 \
    && ln -s libggml-cpu.so.0.9.5 /opt/whisper/lib/libggml-cpu.so.0

ARG WHISPER_MODEL_SHA256=921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f
RUN mkdir -p /opt/whisper/models \
    && curl --fail --location --proto '=https' --tlsv1.2 \
      https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin \
      --output /opt/whisper/models/ggml-tiny.en.bin \
    && echo "${WHISPER_MODEL_SHA256}  /opt/whisper/models/ggml-tiny.en.bin" | sha256sum --check --strict

FROM docker.io/library/python:3.12-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY --from=whisper-builder /opt/whisper /opt/whisper
ENV LD_LIBRARY_PATH=/opt/whisper/lib
WORKDIR /bitfield/workspace

RUN echo "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f  /opt/whisper/models/ggml-tiny.en.bin" \
      | sha256sum --check --strict \
    && /usr/bin/ffmpeg -version >/dev/null \
    && /opt/whisper/bin/whisper-cli --help >/dev/null \
    && ! ldd /opt/whisper/bin/whisper-cli | grep -F 'not found'

# The process engine selects /usr/local/bin/python3 as provider_entrypoint and
# mounts the existing package script plus source recording in this workspace.
# No service is started and no runtime network access is needed.
CMD ["/usr/local/bin/python3"]
