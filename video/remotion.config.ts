import { Config } from "@remotion/cli/config";

// The card draws with WebGPU. With ANGLE, Chrome gives it the Mac's own GPU (Metal); by default it
// gets SwiftShader, which draws on the CPU.
Config.setChromiumOpenGlRenderer("angle");
// Frames go to the encoder as PNG, so the small print gets no JPEG pass before the video's own.
Config.setVideoImageFormat("png");
