import { TFile } from "obsidian";

export class Base64File {
    buffer: ArrayBuffer;
    filename: string;
    mimeType: string;

    constructor(buffer: ArrayBuffer, filename?: string, mimeType?: string) {
        this.buffer = buffer;
        this.filename = filename || "image";
        this.mimeType = mimeType || this.detectMimeType();
    }

    private detectMimeType(): string {
        const arr = new Uint8Array(this.buffer).subarray(0, 12);
        // PNG: 89 50 4E 47 0D 0A 1A 0A
        if (arr[0] === 0x89 && arr[1] === 0x50 && arr[2] === 0x4E && arr[3] === 0x47) {
            return 'image/png';
        }
        // JPEG: FF D8 FF
        if (arr[0] === 0xFF && arr[1] === 0xD8 && arr[2] === 0xFF) {
            return 'image/jpeg';
        }
        // WebP: RIFF....WEBP
        if (arr[0] === 0x52 && arr[1] === 0x49 && arr[2] === 0x46 && arr[3] === 0x46 &&
            arr[8] === 0x57 && arr[9] === 0x45 && arr[10] === 0x42 && arr[11] === 0x50) {
            return 'image/webp';
        }
        // GIF: GIF87a or GIF89a
        if (arr[0] === 0x47 && arr[1] === 0x49 && arr[2] === 0x46) {
            return 'image/gif';
        }
        return 'image/png'; // Default fallback
    }

    get size() {
        return this.buffer.byteLength;
    }

    get base64Size(): number {
        // Base64 encoding increases size by ~33%
        return Math.ceil(this.buffer.byteLength * 4 / 3);
    }

    to64String() {
        const bytes = new Uint8Array(this.buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    to64Link() {
        return `![${this.filename}](data:${this.mimeType};base64,${this.to64String()})`;
    }

    to64Data(): string {
        return `data:${this.mimeType};base64,${this.to64String()}`;
    }

    async convertFormat(format: 'webp' | 'jpeg' | 'png', quality: number): Promise<Base64File> {
        return new Promise((resolve, reject) => {
            const blob = new Blob([this.buffer], { type: this.mimeType });
            const imageUrl = URL.createObjectURL(blob);
            const img = new Image();

            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    URL.revokeObjectURL(imageUrl);
                    reject(new Error('Could not get canvas context'));
                    return;
                }

                canvas.width = img.width;
                canvas.height = img.height;
                ctx.drawImage(img, 0, 0);

                const mimeType = `image/${format}`;
                const qualityValue = quality / 100;

                canvas.toBlob((resultBlob) => {
                    URL.revokeObjectURL(imageUrl);
                    if (!resultBlob) {
                        reject(new Error('Could not create blob from canvas'));
                        return;
                    }

                    resultBlob.arrayBuffer().then(arrayBuffer => {
                        const ext = format === 'jpeg' ? 'jpg' : format;
                        const newFilename = this.filename.replace(/\.[^/.]+$/, `.${ext}`);
                        resolve(new Base64File(arrayBuffer, newFilename, mimeType));
                    }).catch(reject);
                }, mimeType, qualityValue);
            };

            img.onerror = () => {
                URL.revokeObjectURL(imageUrl);
                reject(new Error('Failed to load image for format conversion'));
            };

            img.src = imageUrl;
        });
    }

    async resizeToMaxDimensions(maxWidth: number, maxHeight: number): Promise<Base64File> {
        return new Promise((resolve, reject) => {
            const blob = new Blob([this.buffer], { type: this.mimeType });
            const imageUrl = URL.createObjectURL(blob);
            const img = new Image();

            img.onload = () => {
                let newWidth = img.width;
                let newHeight = img.height;

                // Calculate new dimensions maintaining aspect ratio
                if (maxWidth > 0 && newWidth > maxWidth) {
                    newHeight = Math.round(newHeight * (maxWidth / newWidth));
                    newWidth = maxWidth;
                }
                if (maxHeight > 0 && newHeight > maxHeight) {
                    newWidth = Math.round(newWidth * (maxHeight / newHeight));
                    newHeight = maxHeight;
                }

                // If no resizing needed, return original
                if (newWidth === img.width && newHeight === img.height) {
                    URL.revokeObjectURL(imageUrl);
                    resolve(this);
                    return;
                }

                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    URL.revokeObjectURL(imageUrl);
                    reject(new Error('Could not get canvas context'));
                    return;
                }

                canvas.width = newWidth;
                canvas.height = newHeight;
                ctx.drawImage(img, 0, 0, newWidth, newHeight);

                canvas.toBlob((resultBlob) => {
                    URL.revokeObjectURL(imageUrl);
                    if (!resultBlob) {
                        reject(new Error('Could not create blob from canvas'));
                        return;
                    }

                    resultBlob.arrayBuffer().then(arrayBuffer => {
                        resolve(new Base64File(arrayBuffer, this.filename, this.mimeType));
                    }).catch(reject);
                }, this.mimeType);
            };

            img.onerror = () => {
                URL.revokeObjectURL(imageUrl);
                reject(new Error('Failed to load image for resizing'));
            };

            img.src = imageUrl;
        });
    }

    async compressToSize(targetSizeKB: number, preferredFormat: 'webp' | 'jpeg' | 'png', minQuality: number = 20): Promise<Base64File> {
        let quality = 95;
        let result = await this.convertFormat(preferredFormat, quality);
        
        // Binary search for optimal quality
        let low = minQuality;
        let high = 95;
        
        while (result.base64Size / 1024 > targetSizeKB && low < high) {
            quality = Math.floor((low + high) / 2);
            result = await this.convertFormat(preferredFormat, quality);
            
            if (result.base64Size / 1024 > targetSizeKB) {
                high = quality - 1;
            } else {
                low = quality + 1;
            }
        }
        
        return result;
    }

    //class methods
    static from64Link(link: string) {
        const match = link.match(/!\[(.*?)\]\(data:(image\/[^;]+);base64,([^)]+)\)/);
        if (!match) return null;
        const filename = match[1];
        const mimeType = match[2];
        const base64 = match[3];
        const buffer = Buffer.from(base64, 'base64');
        return new Base64File(buffer, filename, mimeType);
    }

    static from64String(base64: string, filename?: string, mimeType?: string) {
        const buffer = Buffer.from(base64, 'base64');
        return new Base64File(buffer, filename, mimeType);
    }

    static async fromFile(file: File) {
        const arrayBuffer = await file.arrayBuffer();
        return new Base64File(arrayBuffer, file.name, file.type || undefined);
    }

    static async fromTFile(tfile: TFile) {
        const arrayBuffer = await tfile.vault.readBinary(tfile);
        const ext = tfile.extension.toLowerCase();
        let mimeType = 'image/png';
        if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg';
        else if (ext === 'webp') mimeType = 'image/webp';
        else if (ext === 'gif') mimeType = 'image/gif';
        return new Base64File(arrayBuffer, tfile.name, mimeType);
    }
}

export class Base64Conversion {
    async fromClipboardEvent(event: ClipboardEvent): Promise<Base64File | null> {
        const items = event.clipboardData?.items;
        if (!items) return null;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) {
                    return this.fromFile(file);
                }
            }
        }
        return null;
    }

    async fromClipboard(): Promise<Base64File | null> {
        try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
                if (item.types.includes('image/png') || item.types.includes('image/jpeg')) {
                    const blob = await item.getType('image/png') || await item.getType('image/jpeg');
                    if (blob) {
                        const arrayBuffer = await blob.arrayBuffer();
                        return new Base64File(arrayBuffer);
                    }
                }
            }
        } catch (error) {
            console.error('Error reading from clipboard:', error);
        }
        return null;
    }

    async fromFile(file: File): Promise<Base64File> {
        const arrayBuffer = await file.arrayBuffer();
        return new Base64File(arrayBuffer, file.name);
    }
    async fromTFile(tfile: TFile): Promise<Base64File> {
        const arrayBuffer = await tfile.vault.readBinary(tfile);
        return new Base64File(arrayBuffer);
    }   

    async resize(file: Base64File, percentage: number): Promise<Base64File> {
        return new Promise((resolve, reject) => {
            const blob = new Blob([file.buffer]);
            const imageUrl = URL.createObjectURL(blob);
            const img = new Image();
            
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    reject(new Error('Could not get canvas context'));
                    return;
                }

                const newWidth = Math.round(img.width * (percentage / 100));
                const newHeight = Math.round(img.height * (percentage / 100));
                
                canvas.width = newWidth;
                canvas.height = newHeight;
                ctx.drawImage(img, 0, 0, newWidth, newHeight);

                canvas.toBlob((blob) => {
                    if (!blob) {
                        reject(new Error('Could not create blob from canvas'));
                        return;
                    }
                    
                    blob.arrayBuffer().then(arrayBuffer => {
                        URL.revokeObjectURL(imageUrl);
                        resolve(new Base64File(arrayBuffer));
                    }).catch(reject);
                }, 'image/png');
            };

            img.onerror = () => {
                URL.revokeObjectURL(imageUrl);
                reject(new Error('Failed to load image'));
            };

            img.src = imageUrl;
        });
    }
}