FROM node:18-bullseye

RUN apt update && apt install -y \
 openjdk-17-jdk \
 wget unzip

ENV ANDROID_SDK_ROOT=/opt/android-sdk
RUN mkdir -p $ANDROID_SDK_ROOT/cmdline-tools

RUN wget https://dl.google.com/android/repository/commandlinetools-linux-9477386_latest.zip \
 && unzip commandlinetools-linux-*.zip \
 && mv cmdline-tools $ANDROID_SDK_ROOT/cmdline-tools/latest

ENV PATH=$PATH:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/build-tools/34.0.0

RUN yes | sdkmanager --licenses
RUN sdkmanager "build-tools;34.0.0"

WORKDIR /app
COPY . .

RUN npm install
RUN mkdir -p uploads uploads_tmp output keys

CMD ["node","server.js"]
