// lib/YouTubeStreamer.ts
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs';
import { EventEmitter } from 'events';
import path from 'path';
export class YouTubeStreamer extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this._isStreaming = false;
        // In Docker, use system ffmpeg instead of ffmpeg-static
        const ffmpegBinary = process.env.DOCKER_CONTAINER ? 'ffmpeg' : ffmpegPath;
        console.log('Using FFmpeg binary:', ffmpegBinary);
        // Set default video size if not provided
        const videoSize = this.config.videoSize || '1280x720';
        this.command = ffmpeg();
        // Convert Windows-style paths to POSIX paths in Docker environment
        let thumbnailPath = this.config.thumbnailPath;
        if (thumbnailPath && process.env.DOCKER_CONTAINER) {
            thumbnailPath = thumbnailPath.replace(/\\/g, '/');
            if (thumbnailPath.includes(':')) {
                thumbnailPath = thumbnailPath.split(':')[1]; // Remove drive letter
            }
        }
        // If thumbnail is provided, use it; otherwise use black background
        if (thumbnailPath && fs.existsSync(thumbnailPath)) {
            console.log('Using thumbnail:', thumbnailPath);
            this.command
                .input(thumbnailPath)
                .inputOptions([
                '-loop 1', // Loop the image
                '-framerate 1' // 1 frame per second
            ]);
        }
        else {
            console.log('Using black background');
            // Generate black video using color filter
            this.command
                .input('nullsrc')
                .inputOptions([
                '-f', 'rawvideo',
                '-video_size', videoSize,
                '-pix_fmt', 'rgb24',
                '-r', '1' // 1 frame per second
            ])
                .videoFilters([
                'geq=r=0:g=0:b=0' // Generate black color
            ]);
        }
        // Add audio input
        this.command
            .input(this.config.audioUrl)
            .inputOptions([
            '-f', 'aac'
        ])
            // Video settings
            .videoCodec('libx264')
            .outputOptions([
            '-preset ultrafast',
            '-tune stillimage',
            '-r 1', // 1 frame per second
            '-g 2', // GOP size of 2
            '-c:a copy', // Copy audio without re-encoding
            '-shortest', // End when shortest input ends
            '-pix_fmt yuv420p', // Required for compatibility
            '-f flv' // FLV output format
        ])
            .output(`rtmp://a.rtmp.youtube.com/live2/${this.config.streamKey}`)
            .on('start', (commandLine) => {
            console.log('FFmpeg process started with command:', commandLine);
            this._isStreaming = true;
            this.emit('status', { isStreaming: true, command: commandLine });
        })
            .on('stderr', (stderrLine) => {
            console.log('FFmpeg:', stderrLine);
            this.emit('log', { type: 'ffmpeg', message: stderrLine });
        })
            .on('progress', (progress) => {
            const streamProgress = {
                frames: progress.frames,
                currentFps: progress.currentFps,
                currentKbps: progress.currentKbps,
                timemark: progress.timemark
            };
            console.log('FFmpeg Progress:', streamProgress);
            this.emit('progress', streamProgress);
        })
            .on('error', (err, stdout, stderr) => {
            console.error('Stream error:', err.message);
            console.error('FFmpeg stdout:', stdout);
            console.error('FFmpeg stderr:', stderr);
            this.emit('error', { error: err.message, stdout, stderr });
            this.cleanup();
        })
            .on('end', () => {
            console.log('FFmpeg process ended');
            this.cleanup();
            this.emit('end');
        });
        // Start streaming immediately
        this.startStream();
    }
    startStream() {
        if (this._isStreaming) {
            return;
        }
        console.log('Starting stream...');
        console.log('Audio URL:', this.config.audioUrl);
        if (this.config.thumbnailPath) {
            console.log('Using thumbnail:', this.config.thumbnailPath);
        }
        else {
            console.log('Using black background');
        }
        this._isStreaming = true;
        this.command?.run();
    }
    stopStream() {
        if (this._isStreaming && this.command) {
            this._isStreaming = false;
            this.command.kill('SIGKILL');
            this.command = null;
            this.emit('status', { isStreaming: false });
        }
    }
    cleanup() {
        this._isStreaming = false;
        this.emit('status', { isStreaming: false });
    }
    get isStreaming() {
        return this._isStreaming;
    }
    getStatus() {
        return {
            isStreaming: this._isStreaming,
            config: this.config
        };
    }
}
