FROM eclipse-temurin:21-jre-jammy AS java

FROM node:24.12.0-bookworm-slim
COPY --from=java /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH=/opt/java/openjdk/bin:$PATH
WORKDIR /app
COPY scripts/geo/graphhopper-launch.mjs /app/scripts/geo/graphhopper-launch.mjs
USER node
