import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { Base64Conversion, Base64File } from './utils/conversion';
import { linkDecorations } from './coms/antiLinkExpand';
import { registerExportToLocal } from './comsContext/export';
import { registerConvertImage } from './comsContext/convert';
import { registerConvertCommand } from './commands/selectAndConvert';
import { registerExportCommand } from './commands/selectAndExport';
import { registerCursorEscape } from './coms/cursorEscape';
import { registerInlineFolderImagesCommand } from './commands/inlineFolderImages';

export interface ImageInlineSettings {
	// General settings
	convertOnPaste: boolean;
	convertOnDrop: boolean;
	autoEscapeLink: boolean; 

	// Image Format Settings
	outputFormat: 'auto' | 'webp' | 'jpeg' | 'png';
	jpegQuality: number;  // 1-100, default 85
	webpQuality: number;  // 1-100, default 80

	// Resolution Limits
	maxWidth: number;     // Maximum width in pixels (0 = no limit)
	maxHeight: number;    // Maximum height in pixels (0 = no limit)

	// Size Limits
	maxBase64SizeKB: number;  // Maximum base64 string size in KB (0 = no limit)
	enableAutoCompress: boolean;  // Auto-compress if exceeds limit
}

const DEFAULT_SETTINGS: ImageInlineSettings = {
	convertOnPaste: true,
	convertOnDrop: true,
	autoEscapeLink: true,
	// Image format defaults
	outputFormat: 'auto',
	jpegQuality: 85,
	webpQuality: 80,
	// Resolution limits (0 = no limit)
	maxWidth: 1920,
	maxHeight: 0,
	// Size limits
	maxBase64SizeKB: 500,
	enableAutoCompress: true
}

export default class ImageInlinePlugin extends Plugin {
	settings: ImageInlineSettings;
	conversion: Base64Conversion;

	async onload() {
		await this.loadSettings();
		this.conversion = new Base64Conversion();

		// Register the anti-link expansion view plugin
		this.registerEditorExtension(linkDecorations);

		// Register export to local functionality
		await registerExportToLocal(this);

		await registerConvertImage(this);

		// Register cursor escape functionality
		registerCursorEscape(this);

		//  command to select and convert images
		await registerConvertCommand(this);

		//  command to select and export images
		await registerExportCommand(this);

		// Command to inline images from a folder
		registerInlineFolderImagesCommand(this);

		// Register paste event
		this.registerEvent(
			this.app.workspace.on('editor-paste', async (evt: ClipboardEvent, editor: Editor) => {
				if (!this.settings.convertOnPaste) return;
				
				const items = evt.clipboardData?.items;
				if (!items) return;

				// Check if all items are images
				const allImages = Array.from(items).every(item => item.type.startsWith('image/'));
				if (!allImages) return; // Let the app handle mixed content

				evt.preventDefault();
				const base64Files: Base64File[] = [];

				for (const item of Array.from(items)) {
					if (item.type.startsWith('image/')) {
						const file = item.getAsFile();
						if (file) {
							const base64File = await this.conversion.fromFile(file);
							base64Files.push(base64File);
						}
					}
				}

				if (base64Files.length > 0) {
					await this.handleImages(base64Files, editor);
				}
			})
		);

		// Register drop event
		this.registerEvent(
			this.app.workspace.on('editor-drop', async (evt: DragEvent, editor: Editor) => {
				if (!this.settings.convertOnDrop) return;
				
				const files = evt.dataTransfer?.files;
				if (!files || files.length === 0) return;

				// Check if all files are images
				const allImages = Array.from(files).every(file => file.type.startsWith('image/'));
				if (!allImages) return; // Let the app handle mixed content

				evt.preventDefault();
				const base64Files: Base64File[] = [];

				for (const file of Array.from(files)) {
					if (file.type.startsWith('image/')) {
						const base64File = await this.conversion.fromFile(file);
						base64Files.push(base64File);
					}
				}

				if (base64Files.length > 0) {
					await this.handleImages(base64Files, editor);
				}
			})
		);

		// Add settings tab
		this.addSettingTab(new ImageInlineSettingTab(this.app, this));
	}

	async handleImages(base64Files: Base64File[], editor: Editor) {
		try {
			const processedFiles: Base64File[] = [];
			const attachments: Base64File[] = [];

			for (let base64File of base64Files) {
				// Step 1: Apply resolution limits
				if (this.settings.maxWidth > 0 || this.settings.maxHeight > 0) {
					base64File = await base64File.resizeToMaxDimensions(
						this.settings.maxWidth,
						this.settings.maxHeight
					);
				}

				// Step 2: Apply format conversion
				if (this.settings.outputFormat !== 'auto') {
					const quality = this.settings.outputFormat === 'jpeg' 
						? this.settings.jpegQuality 
						: this.settings.outputFormat === 'webp'
							? this.settings.webpQuality
							: 100;
					base64File = await base64File.convertFormat(this.settings.outputFormat, quality);
				} else {
					// Auto-select: try WebP first for best compression
					const webpFile = await base64File.convertFormat('webp', this.settings.webpQuality);
					const jpegFile = await base64File.convertFormat('jpeg', this.settings.jpegQuality);
					
					// Choose smallest
					if (webpFile.size <= jpegFile.size && webpFile.size <= base64File.size) {
						base64File = webpFile;
					} else if (jpegFile.size < base64File.size) {
						base64File = jpegFile;
					}
					// else keep original format
				}

				// Step 3: Check size limits and auto-compress if needed
				const base64SizeKB = base64File.base64Size / 1024;
				if (this.settings.maxBase64SizeKB > 0 && base64SizeKB > this.settings.maxBase64SizeKB) {
					if (this.settings.enableAutoCompress) {
						const format = base64File.mimeType.includes('webp') ? 'webp' 
							: base64File.mimeType.includes('jpeg') ? 'jpeg' : 'webp';
						base64File = await base64File.compressToSize(
							this.settings.maxBase64SizeKB,
							format
						);
					} else {
						// Save as attachment if auto-compress is disabled
						attachments.push(base64File);
						continue;
					}
				}

				processedFiles.push(base64File);
			}

			// Insert processed files as inline base64 links
			if (processedFiles.length > 0) {
				const markdown = processedFiles.map(file => file.to64Link()).join('\n');
				editor.replaceSelection(markdown);
			}

			// Handle attachments
			if (attachments.length > 0) {
				new Notice(`${attachments.length} image(s) will be saved as attachments`);
				for (const attachment of attachments) {
					const activeFile = this.app.workspace.getActiveFile();
					if (activeFile) {
						const file = new File([attachment.buffer], attachment.filename, { type: attachment.mimeType });
						const targetPath = await this.app.fileManager.getAvailablePathForAttachment(
							attachment.filename,
							activeFile.path
						);
						
						const newFile = await this.app.vault.createBinary(
							targetPath,
							await file.arrayBuffer()
						) as TFile;
						
						const link = this.app.fileManager.generateMarkdownLink(
							newFile,
							activeFile.path
						);
						editor.replaceSelection(link + '\n');
					}
				}
			}
		} catch (error) {
			new Notice('Failed to process images: ' + error.message);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

}

class ImageInlineSettingTab extends PluginSettingTab {
	plugin: ImageInlinePlugin;

	constructor(app: App, plugin: ImageInlinePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// General Settings Section
		containerEl.createEl('h2', { text: 'General Settings' });

		new Setting(containerEl)
			.setName('Convert on paste')
			.setDesc('Convert images pasted into the editor to base64')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.convertOnPaste)
				.onChange(async (value) => {
					this.plugin.settings.convertOnPaste = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Convert on drop')
			.setDesc('Convert images dropped into the editor to base64')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.convertOnDrop)
				.onChange(async (value) => {
					this.plugin.settings.convertOnDrop = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto escape base64 data section')
			.setDesc('Automatically move cursor out of the base64 data section')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoEscapeLink)
				.onChange(async (value) => {
					this.plugin.settings.autoEscapeLink = value;
					await this.plugin.saveSettings();
				}));

		// Image Optimization Section
		containerEl.createEl('h2', { text: 'Image Optimization' });

		new Setting(containerEl)
			.setName('Output format')
			.setDesc('Choose the output image format (auto selects smallest)')
			.addDropdown(dropdown => dropdown
				.addOption('auto', 'Auto (smallest size)')
				.addOption('webp', 'WebP')
				.addOption('jpeg', 'JPEG')
				.addOption('png', 'PNG')
				.setValue(this.plugin.settings.outputFormat)
				.onChange(async (value: 'auto' | 'webp' | 'jpeg' | 'png') => {
					this.plugin.settings.outputFormat = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.outputFormat === 'jpeg' || this.plugin.settings.outputFormat === 'auto') {
			new Setting(containerEl)
				.setName('JPEG quality')
				.setDesc('Quality for JPEG encoding (1-100)')
				.addSlider(slider => slider
					.setLimits(1, 100, 1)
					.setValue(this.plugin.settings.jpegQuality)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.jpegQuality = value;
						await this.plugin.saveSettings();
					}));
		}

		if (this.plugin.settings.outputFormat === 'webp' || this.plugin.settings.outputFormat === 'auto') {
			new Setting(containerEl)
				.setName('WebP quality')
				.setDesc('Quality for WebP encoding (1-100)')
				.addSlider(slider => slider
					.setLimits(1, 100, 1)
					.setValue(this.plugin.settings.webpQuality)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.webpQuality = value;
						await this.plugin.saveSettings();
					}));
		}

		// Resolution Limits Section
		containerEl.createEl('h2', { text: 'Resolution Limits' });

		new Setting(containerEl)
			.setName('Maximum width')
			.setDesc('Maximum image width in pixels (0 = no limit)')
			.addText(text => text
				.setValue(this.plugin.settings.maxWidth.toString())
				.setPlaceholder('1920')
				.onChange(async (value) => {
					const num = Number(value);
					if (!isNaN(num) && num >= 0) {
						this.plugin.settings.maxWidth = num;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Maximum height')
			.setDesc('Maximum image height in pixels (0 = no limit)')
			.addText(text => text
				.setValue(this.plugin.settings.maxHeight.toString())
				.setPlaceholder('0')
				.onChange(async (value) => {
					const num = Number(value);
					if (!isNaN(num) && num >= 0) {
						this.plugin.settings.maxHeight = num;
						await this.plugin.saveSettings();
					}
				}));

		// Size Limits Section
		containerEl.createEl('h2', { text: 'Size Limits' });

		new Setting(containerEl)
			.setName('Maximum base64 size (KB)')
			.setDesc('Maximum size of base64 string in KB (0 = no limit)')
			.addText(text => text
				.setValue(this.plugin.settings.maxBase64SizeKB.toString())
				.setPlaceholder('500')
				.onChange(async (value) => {
					const num = Number(value);
					if (!isNaN(num) && num >= 0) {
						this.plugin.settings.maxBase64SizeKB = num;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Auto-compress')
			.setDesc('Automatically compress images that exceed the size limit')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableAutoCompress)
				.onChange(async (value) => {
					this.plugin.settings.enableAutoCompress = value;
					await this.plugin.saveSettings();
				}));
	}
}

