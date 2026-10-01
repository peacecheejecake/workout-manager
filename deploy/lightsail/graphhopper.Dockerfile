FROM eclipse-temurin:21-jre-jammy AS java

FROM node:24.12.0-bookworm-slim
COPY --from=java /opt/java/openjdk /opt/java/openjdk
RUN groupadd --gid 20002 graphhopper \
 && useradd --uid 20002 --gid graphhopper --create-home --home-dir /home/graphhopper \
      --shell /usr/sbin/nologin --no-log-init graphhopper
ENV JAVA_HOME=/opt/java/openjdk \
    HOME=/home/graphhopper
ENV PATH=/opt/java/openjdk/bin:$PATH
WORKDIR /app
COPY scripts/geo/graphhopper-launch.mjs /app/scripts/geo/graphhopper-launch.mjs
USER graphhopper:graphhopper
