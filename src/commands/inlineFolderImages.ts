import { App, Modal, Notice, Plugin, TFile, TFolder, FuzzySuggestModal } from "obsidian";
import { Base64File } from "../utils/conversion";

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
    private onSelect: (folder: TFolder) => void;

    constructor(app: App, onSelect: (folder: TFolder) => void) {
        super(app);
        this.onSelect = onSelect;
        this.setPlaceholder("Select a folder...");
    }

    getItems(): TFolder[] {
        const folders: TFolder[] = [];
        const root = this.app.vault.getRoot();
        
        const collectFolders = (folder: TFolder) => {
            folders.push(folder);
            for (const child of folder.children) {
                if (child instanceof TFolder) {
                    collectFolders(child);
                }
            }
        };
        
        collectFolders(root);
        return folders;
    }

    getItemText(folder: TFolder): string {
        return folder.path || "/";
    }

    onChooseItem(folder: TFolder, evt: MouseEvent | KeyboardEvent): void {
        this.onSelect(folder);
    }
}

async function inlineFolderImages(app: App, folder: TFolder): Promise<void> {
    // Find markdown files in the folder
    const markdownFiles = folder.children.filter(
        (child): child is TFile => child instanceof TFile && child.extension === "md"
    );

    if (markdownFiles.length === 0) {
        new Notice("No markdown files found in the selected folder");
        return;
    }

    // Process first markdown file (or you could process all)
    const sourceFile = markdownFiles[0];
    let content = await app.vault.read(sourceFile);

    // Find image files in the folder (for resolving references)
    const imageExtensions = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
    const imageFiles = folder.children.filter(
        (child): child is TFile => 
            child instanceof TFile && 
            imageExtensions.includes(child.extension.toLowerCase())
    );

    // Create a map of image filenames to TFile objects
    const imageMap = new Map<string, TFile>();
    for (const img of imageFiles) {
        imageMap.set(img.name, img);
        imageMap.set(img.basename, img);
    }

    // Pattern 1: Standard markdown images - ![alt](path)
    const standardPattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
    // Pattern 2: Obsidian wiki-links - ![[image.ext]]
    const wikiLinkPattern = /!\[\[([^\]]+)\]\]/g;

    let convertedCount = 0;
    const errors: string[] = [];

    // Process standard markdown images
    const standardMatches = Array.from(content.matchAll(standardPattern));
    for (const match of standardMatches) {
        const fullMatch = match[0];
        const altText = match[1];
        const imagePath = match[2];

        // Skip if already base64
        if (imagePath.startsWith("data:")) {
            continue;
        }

        // Try to find the image file
        const filename = imagePath.split("/").pop() || imagePath;
        let imageFile = imageMap.get(filename);

        // If not found in folder, try to resolve via vault
        if (!imageFile) {
            const resolved = app.metadataCache.getFirstLinkpathDest(imagePath, sourceFile.path);
            if (resolved instanceof TFile) {
                imageFile = resolved;
            }
        }

        if (imageFile) {
            try {
                const base64File = await Base64File.fromTFile(imageFile);
                const base64Link = `![${altText || imageFile.basename}](${base64File.to64Data()})`;
                content = content.replace(fullMatch, base64Link);
                convertedCount++;
            } catch (err) {
                errors.push(`Failed to convert ${filename}: ${err.message}`);
            }
        } else {
            errors.push(`Image not found: ${imagePath}`);
        }
    }

    // Process Obsidian wiki-link images
    const wikiMatches = Array.from(content.matchAll(wikiLinkPattern));
    for (const match of wikiMatches) {
        const fullMatch = match[0];
        const imagePath = match[1];

        // Try to find the image file
        const filename = imagePath.split("/").pop() || imagePath;
        let imageFile = imageMap.get(filename);

        // If not found in folder, try to resolve via vault
        if (!imageFile) {
            const resolved = app.metadataCache.getFirstLinkpathDest(imagePath, sourceFile.path);
            if (resolved instanceof TFile) {
                imageFile = resolved;
            }
        }

        if (imageFile) {
            try {
                const base64File = await Base64File.fromTFile(imageFile);
                const base64Link = `![${imageFile.basename}](${base64File.to64Data()})`;
                content = content.replace(fullMatch, base64Link);
                convertedCount++;
            } catch (err) {
                errors.push(`Failed to convert ${filename}: ${err.message}`);
            }
        } else {
            errors.push(`Image not found: ${imagePath}`);
        }
    }

    // Create new file with _inline suffix
    const newFilename = sourceFile.basename + "_inline.md";
    const newFilePath = folder.path ? `${folder.path}/${newFilename}` : newFilename;

    // Check if file already exists and use a unique name if so
    let finalPath = newFilePath;
    let counter = 1;
    while (app.vault.getAbstractFileByPath(finalPath)) {
        const altName = `${sourceFile.basename}_inline_${counter}.md`;
        finalPath = folder.path ? `${folder.path}/${altName}` : altName;
        counter++;
    }

    await app.vault.create(finalPath, content);

    // Show results
    if (errors.length > 0) {
        new Notice(`Converted ${convertedCount} images with ${errors.length} errors. Check console for details.`);
        console.error("Image inline errors:", errors);
    } else {
        new Notice(`Successfully converted ${convertedCount} images. Created: ${finalPath}`);
    }

    // Open the new file
    const newFile = app.vault.getAbstractFileByPath(finalPath);
    if (newFile instanceof TFile) {
        await app.workspace.getLeaf().openFile(newFile);
    }
}

export function registerInlineFolderImagesCommand(plugin: Plugin) {
    plugin.addCommand({
        id: "inline-folder-images",
        name: "Inline Images from Folder",
        callback: () => {
            new FolderSuggestModal(plugin.app, async (folder: TFolder) => {
                await inlineFolderImages(plugin.app, folder);
            }).open();
        }
    });
}
