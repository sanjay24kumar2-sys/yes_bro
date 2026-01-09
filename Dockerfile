FROM node:18-bullseye

RUN apt update && apt install -y openjdk-17-jdk wget unzip

ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH=$JAVA_HOME/bin:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/build-tools/34.0.0

RUN mkdir -p $ANDROID_SDK_ROOT/cmdline-tools
WORKDIR /opt

RUN wget https://dl.google.com/android/repository/commandlinetools-linux-9477386_latest.zip \
 && unzip commandlinetools-linux-9477386_latest.zip \
 && mv cmdline-tools $ANDROID_SDK_ROOT/cmdline-tools/latest

RUN yes | sdkmanager --sdk_root=$ANDROID_SDK_ROOT --licenses
RUN sdkmanager --sdk_root=$ANDROID_SDK_ROOT "build-tools;34.0.0"

WORKDIR /app
COPY . .
RUN npm install
EXPOSE 3000
CMD ["npm","start"]
