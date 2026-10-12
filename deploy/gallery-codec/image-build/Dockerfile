FROM --platform=linux/arm64 docker.io/library/gcc@sha256:66035d353338cb93b64f621393dc6fecde85258651ca454f0cf36ff2639b1352 AS build
ENV SOURCE_DATE_EPOCH=0 LC_ALL=C LANG=C
WORKDIR /build
COPY . /input
RUN test "$(uname -m)" = aarch64 \
 && test "$(gcc -dumpfullversion)" = 14.3.0 \
 && command -v make && command -v pkg-config && command -v python3 \
 && cd /input && test -f context-checksums.sha256 && sha256sum -c context-checksums.sha256
RUN mkdir -p /build/node /build/x264 /build/ffmpeg /opt/codec \
 && tar -xJf /input/artifacts/node-v24.12.0-linux-arm64.tar.xz -C /build/node --strip-components=1 \
 && test "$(/build/node/bin/node --version)" = v24.12.0 \
 && tar -xzf /input/artifacts/x264-0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee.tar.gz -C /build/x264 --strip-components=1 \
 && tar -xJf /input/artifacts/ffmpeg-9.0.2.tar.xz -C /build/ffmpeg --strip-components=1 \
 && test "$(cat /build/ffmpeg/VERSION)" = 9.0.2
RUN cd /build/x264 \
 && ./configure --prefix=/opt/codec --enable-static --enable-pic --disable-cli --disable-opencl \
 && make -j2 && make install
RUN python3 /input/build-tools/unpack-tools.py \
 && test "$(/build/ninja/ninja --version)" = 1.13.1 \
 && PYTHONPATH=/build/meson python3 -m mesonbuild.mesonmain --version | grep -x 1.9.2 \
 && PATH=/build/ninja:$PATH PYTHONPATH=/build/meson python3 -m mesonbuild.mesonmain setup /build/dav1d-build /build/dav1d \
      --prefix=/opt/codec --libdir=lib --buildtype=release --default-library=static --wrap-mode=nodownload \
      -Db_staticpic=true -Denable_tools=false -Denable_examples=false -Denable_tests=false \
      -Denable_docs=false -Dtestdata_tests=false -Dxxhash_muxer=disabled \
 && PYTHONPATH=/build/meson /build/ninja/ninja -C /build/dav1d-build -j2 \
 && PYTHONPATH=/build/meson /build/ninja/ninja -C /build/dav1d-build install \
 && test "$(PKG_CONFIG_PATH=/opt/codec/lib/pkgconfig pkg-config --modversion dav1d)" = 1.5.4 \
 && cp /build/dav1d/COPYING /opt/codec/dav1d-COPYING \
 && cp /build/dav1d-build/meson-info/intro-buildoptions.json /opt/codec/dav1d-buildoptions.json
RUN cd /build/ffmpeg \
 && PKG_CONFIG_PATH=/opt/codec/lib/pkgconfig ./configure \
      --prefix=/opt/codec --disable-autodetect --disable-shared --enable-static \
      --enable-gpl --enable-libx264 --enable-libdav1d --pkg-config-flags=--static --disable-doc --disable-debug \
      --disable-network --disable-protocols --enable-protocol=fd --disable-avdevice \
 && make -j2 && make install \
 && /opt/codec/bin/ffmpeg -version > /opt/codec/ffmpeg-build.txt \
 && /opt/codec/bin/ffprobe -version > /opt/codec/ffprobe-build.txt \
 && sha256sum /opt/codec/bin/ffmpeg /opt/codec/bin/ffprobe > /opt/codec/binary-sha256.txt \
 && cp config.h config_components.h ffbuild/config.mak /opt/codec/
# system libstdc++/libgcc are needed by Node/libvips; immutable toolchain root supplies them.
RUN mkdir /runtime-libs \
 && cp -L /usr/lib/aarch64-linux-gnu/libstdc++.so.6 /runtime-libs/ \
 && cp -L /lib/aarch64-linux-gnu/libgcc_s.so.1 /runtime-libs/

FROM --platform=linux/arm64 docker.io/library/debian@sha256:a1b86db52ce3daef089e45aabe36dfec4091f82464c25c1fdcf03de197cbe82a
ENV LANG=C LC_ALL=C TMPDIR=/work/tmp
COPY --from=build /build/node/bin/node /usr/local/bin/node
COPY --from=build /runtime-libs/ /usr/lib/aarch64-linux-gnu/
COPY --from=build /opt/codec/bin/ffmpeg /opt/codec/bin/ffprobe /usr/local/bin/
COPY --from=build /opt/codec/ /usr/share/gallery-codec/build/
COPY --from=build /build/node/LICENSE /usr/share/gallery-codec/notices/node-LICENSE
COPY --from=build /build/ffmpeg/COPYING.GPLv2 /usr/share/gallery-codec/notices/ffmpeg-COPYING.GPLv2
COPY --from=build /build/x264/COPYING /usr/share/gallery-codec/notices/x264-COPYING
COPY artifacts/ /usr/share/gallery-codec/sources/
COPY artifacts/ninja-1.13.1-COPYING /usr/share/gallery-codec/notices/ninja-COPYING
COPY licenses/ /usr/share/gallery-codec/inputs/
COPY codec/ /codec/
RUN find /codec -type d -exec chmod 0755 {} + \
 && find /codec -type f -exec chmod a+r {} + \
 && find /codec -type f \( -name "*.js" -o -name "*.mjs" -o -name "*.cjs" -o -name "*.json" \) -exec chmod 0644 {} + \
 && mkdir -p /work/tmp && chown -R 20001:20001 /work && chmod 700 /work/tmp
WORKDIR /work
USER 20001:20001
RUN /usr/local/bin/node --input-type=module -e "const s=(await import('/codec/node_modules/sharp/dist/index.mjs')).default;if(s.versions.sharp!=='0.35.4')process.exit(1);console.log(JSON.stringify({node:process.version,arch:process.arch,sharp:s.versions.sharp,vips:s.versions.vips}))" \
 && /usr/local/bin/ffmpeg -version && /usr/local/bin/ffprobe -version \
 && /usr/local/bin/ffmpeg -hide_banner -decoders 2>&1 | grep -w libdav1d
ENTRYPOINT ["/usr/local/bin/node", "/codec/container-entry.mjs"]
