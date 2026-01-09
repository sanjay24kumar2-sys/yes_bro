# ------------------------------
# Base Image
# ------------------------------
FROM node:18-bullseye

# ------------------------------
# Install dependencies
# ------------------------------
RUN apt update && apt install -y \
    openjdk-17-jdk \
    wget \
    unzip \
    git \
    && rm -rf /var/lib/apt/lists/*

# ------------------------------
# Set JAVA_HOME
# ------------------------------
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV PATH=$JAVA_HOME/bin:$PATH

# ------------------------------
# Android SDK setup
# ------------------------------
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV ANDROID_HOME=/opt/android-sdk

RUN mkdir -p $ANDROID_SDK_ROOT/cmdline-tools

WORKDIR /opt

# Download Android cmdline tools
RUN wget https://dl.google.com/android/repository/commandlinetools-linux-9477386_latest.zip \
    && unzip commandlinetools-linux-9477386_latest.zip \
    && rm commandlinetools-linux-9477386_latest.zip \
    && mv cmdline-tools $ANDROID_SDK_ROOT/cmdline-tools/latest

# ------------------------------
# Add Android tools to PATH
# ------------------------------
ENV PATH=$PATH:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin
ENV PATH=$PATH:$ANDROID_SDK_ROOT/platform-tools
ENV PATH=$PATH:$ANDROID_SDK_ROOT/build-tools/34.0.0

# ------------------------------
# Accept licenses & install build tools
# ------------------------------
RUN yes | sdkmanager --sdk_root=${ANDROID_SDK_ROOT} --licenses

RUN sdkmanager --sdk_root=${ANDROID_SDK_ROOT} \
    "platform-tools" \
    "build-tools;34.0.0"

# ------------------------------
# App setup
# ------------------------------
WORKDIR /app
COPY . .

RUN mkdir -p uploads output keys

RUN npm install

EXPOSE 3000

CMD ["npm", "start"]
