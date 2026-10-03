/*
 * Vesktop Stream Quality - a Vencord/Vesktop user plugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Lets you pin the quality used for screen shares (Go Live) and for the
 * webcam: resolution, frame rate and maximum bitrate.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { showToast, Toasts } from "@webpack/common";

const RESOLUTIONS = {
    "720": { width: 1280, height: 720 },
    "1080": { width: 1920, height: 1080 },
    "1440": { width: 2560, height: 1440 },
    "2160": { width: 3840, height: 2160 }
} as const;

type ResolutionKey = keyof typeof RESOLUTIONS;

function resolution(key: unknown) {
    const k = String(key) as ResolutionKey;
    return RESOLUTIONS[k] ?? RESOLUTIONS["1080"];
}

const settings = definePluginSettings({
    enhanceStream: {
        type: OptionType.BOOLEAN,
        description: "画面共有（Go Live）の画質を指定する",
        default: true
    },
    streamResolution: {
        type: OptionType.SELECT,
        description: "画面共有の解像度",
        options: [
            { label: "720p", value: "720" },
            { label: "1080p", value: "1080", default: true },
            { label: "1440p", value: "1440" },
            { label: "2160p (4K)", value: "2160" }
        ]
    },
    streamFramerate: {
        type: OptionType.SELECT,
        description: "画面共有のフレームレート",
        options: [
            { label: "30 fps", value: 30 },
            { label: "60 fps", value: 60, default: true },
            { label: "120 fps", value: 120 }
        ]
    },
    streamBitrate: {
        type: OptionType.SELECT,
        description: "画面共有の最大ビットレート",
        options: [
            { label: "4 Mbps", value: 4_000_000 },
            { label: "8 Mbps", value: 8_000_000, default: true },
            { label: "12 Mbps", value: 12_000_000 },
            { label: "20 Mbps", value: 20_000_000 }
        ]
    },
    enhanceCamera: {
        type: OptionType.BOOLEAN,
        description: "Webカメラの画質を改善する",
        default: true
    },
    cameraResolution: {
        type: OptionType.SELECT,
        description: "Webカメラの解像度",
        options: [
            { label: "720p", value: "720" },
            { label: "1080p", value: "1080", default: true },
            { label: "1440p", value: "1440" }
        ]
    },
    cameraFramerate: {
        type: OptionType.SELECT,
        description: "Webカメラのフレームレート",
        options: [
            { label: "30 fps", value: 30, default: true },
            { label: "60 fps", value: 60 }
        ]
    },
    cameraBitrate: {
        type: OptionType.SELECT,
        description: "Webカメラの最大ビットレート",
        options: [
            { label: "2.5 Mbps", value: 2_500_000 },
            { label: "4 Mbps", value: 4_000_000, default: true },
            { label: "8 Mbps", value: 8_000_000 }
        ]
    },
    applyNow: {
        type: OptionType.COMPONENT,
        component: () => <ApplyCameraButton />
    }
});

// Discord stores its media quality defaults in one shared options object. The
// patches below replace the three camera related entries with these objects,
// so mutating them updates Discord's own defaults in place.
const cameraCapture = { width: 1920, height: 1080, framerate: 60 };
const cameraBudget = { width: 1920, height: 1080, framerate: 60 };
const cameraBitrate = { min: 150_000, max: 4_000_000 };

const DEFAULT_CAMERA = {
    capture: { width: 1280, height: 720, framerate: 30 },
    bitrate: { min: 150_000, max: 2_500_000 }
};

function applyCameraOptions() {
    if (!settings.store.enhanceCamera) {
        Object.assign(cameraCapture, DEFAULT_CAMERA.capture);
        Object.assign(cameraBudget, DEFAULT_CAMERA.capture);
        Object.assign(cameraBitrate, DEFAULT_CAMERA.bitrate);
        return;
    }
    const size = resolution(settings.store.cameraResolution);
    const fps = Number(settings.store.cameraFramerate);
    const bitrate = Number(settings.store.cameraBitrate);

    Object.assign(cameraCapture, { width: size.width, height: size.height, framerate: fps });
    Object.assign(cameraBudget, { width: size.width, height: size.height, framerate: fps });
    Object.assign(cameraBitrate, { min: DEFAULT_CAMERA.bitrate.min, max: bitrate });
}

function ApplyCameraButton() {
    return <button
        type="button"
        style={{ marginTop: "4px" }}
        onClick={() => {
            applyCameraOptions();
            showToast("Webカメラ設定を反映しました（通話に入り直すと確実です）", Toasts.Type.SUCCESS);
        }}
    >
        Webカメラ設定を今すぐ反映
    </button>;
}

// getUserMedia constraints for the webcam. "ideal" lets the camera fall back
// gracefully when it cannot deliver the requested resolution/frame rate.
function cameraConstraints() {
    if (!settings.store.enhanceCamera) return {};
    const size = resolution(settings.store.cameraResolution);
    const fps = Number(settings.store.cameraFramerate);
    return {
        width: { ideal: size.width },
        height: { ideal: size.height },
        frameRate: { ideal: fps }
    };
}

// getDefaultGoliveQuality() returns the maximum quality object Discord uses for
// a screen share. Pinning capture/encode/bitrate here fixes the stream quality.
function overrideGoliveQuality<T>(options: T): T {
    if (!settings.store.enhanceStream || !options) return options;
    const o = options as any;
    const size = resolution(settings.store.streamResolution);
    const fps = Number(settings.store.streamFramerate);
    const bitrate = Number(settings.store.streamBitrate);

    if (o.capture) Object.assign(o.capture, { width: size.width, height: size.height, framerate: fps, pixelCount: size.width * size.height });
    if (o.encode) Object.assign(o.encode, { width: size.width, height: size.height, framerate: fps, pixelCount: size.width * size.height });

    o.bitrateMin = Math.min(500_000, bitrate);
    o.bitrateTarget = Math.round(bitrate * 0.75);
    o.bitrateMax = bitrate;
    return options;
}

export default definePlugin({
    name: "VesktopStreamQuality",
    description: "画面共有（Go Live）とWebカメラの解像度・フレームレート・ビットレートを指定します",
    authors: [{ name: "aki_0", id: 0n }],
    tags: ["Voice", "Media"],
    settings,

    // Referenced directly by the patched Discord options object.
    cameraCapture,
    cameraBudget,
    cameraBitrate,
    overrideGoliveQuality,
    cameraConstraints,

    patches: [
        // Discord's shared media quality defaults (module exports "eQ").
        {
            find: "remoteSinkWantsPixelCount",
            replacement: [
                {
                    match: /videoBudget:\{width:1280,height:720,framerate:30\}/,
                    replace: "videoBudget:$self.cameraBudget"
                },
                {
                    match: /videoCapture:\{width:1280,height:720,framerate:30\}/,
                    replace: "videoCapture:$self.cameraCapture"
                },
                {
                    match: /videoBitrate:\{min:15e4,max:25e5\}/,
                    replace: "videoBitrate:$self.cameraBitrate"
                }
            ]
        },
        // Go Live / screen share maximum quality.
        {
            find: "getDefaultGoliveQuality",
            replacement: {
                match: /this\.getDefaultGoliveQuality\(\)/,
                replace: "$self.overrideGoliveQuality($&)"
            }
        },
        // Webcam getUserMedia constraints ("VideoInput: Already destroyed").
        {
            find: "VideoInput: Already destroyed",
            replacement: {
                match: /\{width:1280,\.\.\.t\}/,
                replace: "{...$self.cameraConstraints(),...t}"
            }
        }
    ],

    start() {
        applyCameraOptions();
    }
});
