// lib/YouTubeStreamer.ts
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs';
import { EventEmitter } from 'events';
import path from 'path';
import os from 'os';
export class YouTubeStreamer extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this._isStreaming = false;
        this._isBuffering = false;
        this.bufferCommand = null;
        this.command = null;
        this.bufferSeconds = config.bufferSeconds || 30;
        this.currentBufferIndex = 0;
        this.bufferFiles = [];
        this.bufferUpdateInterval = null;
        // Create buffer directory
        this.bufferDir = path.join(os.tmpdir(), `yt-buffer-${Date.now()}`);
        fs.mkdirSync(this.bufferDir, { recursive: true });
        // Create concat file path
        this.concatFilePath = path.join(this.bufferDir, 'concat.txt');
        // In Docker, use system ffmpeg instead of ffmpeg-static
        const ffmpegBinary = process.env.DOCKER_CONTAINER ? 'ffmpeg' : ffmpegPath;
        console.log('Using FFmpeg binary:', ffmpegBinary);
        // Start buffering immediately
        this.startBuffering();
    }
    async startBuffering() {
        if (this._isBuffering)
            return;
        console.log('Starting continuous buffer...');
        this._isBuffering = true;
        // Start the continuous buffer update process
        this.updateBuffer();
        // Set up interval to create new buffer chunks
        this.bufferUpdateInterval = setInterval(() => {
            this.updateBuffer();
        }, (this.bufferSeconds * 1000) / 2); // Update at half the buffer duration
    }
    updateBuffer() {
        const bufferFile = path.join(this.bufferDir, `buffer-${this.currentBufferIndex}.aac`);
        this.currentBufferIndex++;
        // Create new buffer command
        const bufferCmd = ffmpeg()
            .input(this.config.audioUrl)
            .inputOptions(['-f', 'aac'])
            .outputOptions([
            '-t', (this.bufferSeconds / 2).toString(), // Record half buffer duration
            '-c:a', 'copy'
        ])
            .output(bufferFile);
        // Handle buffer chunk completion
        bufferCmd
            .on('end', () => {
            this.bufferFiles.push(bufferFile);
            // Keep only the last minute of buffer files
            while (this.bufferFiles.length > 4) { // Keep last 4 chunks (2x buffer duration)
                const oldFile = this.bufferFiles.shift();
                if (oldFile && fs.existsSync(oldFile)) {
                    fs.unlinkSync(oldFile);
                }
            }
            // Update concat file
            this.updateConcatFile();
            // Start streaming if not already started
            if (!this._isStreaming && this.bufferFiles.length >= 2) {
                this.setupStreamCommand();
            }
        })
            .on('error', (err) => {
            console.error('Buffer chunk error:', err.message);
            this.emit('error', { error: err.message });
        });
        bufferCmd.run();
    }
    updateConcatFile() {
        // Create concat file content
        const concatContent = this.bufferFiles
            .map(file => `file '${file}'`)
            .join('\n');
        // Add the live input at the end
        fs.writeFileSync(this.concatFilePath, `${concatContent}\nfile '${this.config.audioUrl}'`);
    }
    setupStreamCommand() {
        // Convert Windows-style paths to POSIX paths in Docker environment
        let thumbnailPath = this.config.thumbnailPath;
        if (thumbnailPath && process.env.DOCKER_CONTAINER) {
            thumbnailPath = thumbnailPath.replace(/\\/g, '/');
            if (thumbnailPath.includes(':')) {
                thumbnailPath = thumbnailPath.split(':')[1];
            }
        }
        this.command = ffmpeg();
        // If thumbnail is provided, use it; otherwise use black background
        if (thumbnailPath && fs.existsSync(thumbnailPath)) {
            console.log('Using thumbnail:', thumbnailPath);
            this.command
                .input(thumbnailPath)
                .inputOptions([
                '-loop 1',
                '-framerate 1'
            ]);
        }
        else {
            console.log('Using black background');
            this.command
                .input('nullsrc')
                .inputOptions([
                '-f', 'rawvideo',
                '-video_size', this.config.videoSize || '1280x720',
                '-pix_fmt', 'rgb24',
                '-r', '1'
            ])
                .videoFilters([
                'geq=r=0:g=0:b=0'
            ]);
        }
        // Add concatenated audio input with continuous update
        this.command
            .input(this.concatFilePath)
            .inputOptions([
            '-f', 'concat',
            '-safe', '0',
            '-re' // Read input at native framerate
        ])
            // Video settings
            .videoCodec('libx264')
            .outputOptions([
            '-preset ultrafast',
            '-tune stillimage',
            '-r 1',
            '-g 2',
            '-c:a copy',
            '-shortest',
            '-pix_fmt yuv420p',
            '-f flv'
        ])
            .output(`rtmp://a.rtmp.youtube.com/live2/${this.config.streamKey}`)
            .on('start', (commandLine) => {
            console.log('FFmpeg stream started with command:', commandLine);
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
            this.emit('progress', streamProgress);
        })
            .on('error', (err, stdout, stderr) => {
            console.error('Stream error:', err.message);
            this.emit('error', { error: err.message, stdout, stderr });
            this.cleanup();
        })
            .on('end', () => {
            console.log('FFmpeg process ended');
            this.cleanup();
            this.emit('end');
        });
        // Start streaming
        this.startStream();
    }
    startStream() {
        if (this._isStreaming || !this.command) {
            return;
        }
        console.log('Starting stream with buffered content...');
        this._isStreaming = true;
        this.command.run();
    }
    stopStream() {
        if (this._isStreaming && this.command) {
            this._isStreaming = false;
            this.command.kill('SIGKILL');
            this.command = null;
            this.emit('status', { isStreaming: false });
        }
        if (this._isBuffering && this.bufferCommand) {
            this._isBuffering = false;
            this.bufferCommand.kill('SIGKILL');
            this.bufferCommand = null;
        }
        if (this.bufferUpdateInterval) {
            clearInterval(this.bufferUpdateInterval);
            this.bufferUpdateInterval = null;
        }
        this.cleanup();
    }
    cleanup() {
        this._isStreaming = false;
        this._isBuffering = false;
        // Clean up buffer files and directory
        try {
            this.bufferFiles.forEach(file => {
                if (fs.existsSync(file)) {
                    fs.unlinkSync(file);
                }
            });
            if (fs.existsSync(this.concatFilePath)) {
                fs.unlinkSync(this.concatFilePath);
            }
            if (fs.existsSync(this.bufferDir)) {
                fs.rmdirSync(this.bufferDir);
            }
        }
        catch (err) {
            console.error('Error cleaning up buffer files:', err);
        }
        this.emit('status', { isStreaming: false });
    }
    get isStreaming() {
        return this._isStreaming;
    }
    get isBuffering() {
        return this._isBuffering;
    }
    getStatus() {
        return {
            isStreaming: this._isStreaming,
            isBuffering: this._isBuffering,
            bufferFiles: this.bufferFiles.length,
            config: this.config
        };
    }
}
