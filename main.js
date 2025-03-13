const fs = require("fs");
const path = require("path");
const objectID = require("bson-objectid");
const core = require("@actions/core");
require("dotenv").config();

const apiService = require("./lib/api");
const { getSketches, processStaticFiles } = require("./lib/util");
const log = require("./lib/log");

// Constants
const TEXT_FILE_EXTENSIONS = [".html", ".css", ".js", ".json"];
const DEFAULT_SELECTED_FILE = "sketch.js";

// Configuration
const config = {
  username: core.getInput("p5-username") || process.env.P5_USERNAME,
  password: core.getInput("p5-password") || process.env.P5_PASSWORD,
  sketchesFolder: path.join(
    process.env.GITHUB_WORKSPACE,
    core.getInput("sketch-folder") || process.env.SKETCHES_FOLDER || "sketches"
  ),
  collectionName:
    core.getInput("collection-name") ||
    process.env.COLLECTION_NAME ||
    "My Sketches",
};

// Error handling
const handleError = (message, error) => {
  log.error(
    `${message} ${error.response ? error.response.data : error.message}`
  );
  process.exit(1);
};

// Input validation
const validateConfig = (config) => {
  if (!config.username || !config.password) {
    handleError(
      "Configuration Error",
      new Error(
        "No username or password provided. Please set the P5_USERNAME and P5_PASSWORD environment variables."
      )
    );
  }

  if (!fs.existsSync(config.sketchesFolder)) {
    handleError(
      "Configuration Error",
      new Error(
        `The "${config.sketchesFolder}" folder does not exist. Please check if "SKETCHES_FOLDER" is set correctly.`
      )
    );
  }
};

// File processing
const processCodeFiles = (sketchPath) => {
  const filesData = [];
  const rootId = objectID().toHexString();

  filesData.push({
    id: rootId,
    _id: rootId,
    name: "root",
    content: "",
    fileType: "folder",
    children: [],
  });

  const codeFiles = fs.readdirSync(sketchPath).filter((file) => {
    const fileExt = path.extname(file).toLowerCase();
    return TEXT_FILE_EXTENSIONS.includes(fileExt);
  });

  for (const fileName of codeFiles) {
    const filePath = path.join(sketchPath, fileName);
    const content = fs.readFileSync(filePath, "utf8");
    const fileId = objectID().toHexString();

    filesData.push({
      id: fileId,
      _id: fileId,
      name: fileName,
      content: content,
      fileType: "file",
      isSelectedFile: fileName === DEFAULT_SELECTED_FILE,
      children: [],
    });

    filesData[0].children.push(fileId);
  }

  return { filesData, rootId };
};

// Main function
const main = async () => {
  try {
    validateConfig(config);

    await apiService.login(config.username, config.password);
    const collection = await apiService.getOrCreateCollection(
      config.collectionName
    );

    // Get all static files from the API
    log.info("Fetching information about all static files...");
    const allStaticFiles = await apiService.getStaticFiles();
    log.info(`Found ${allStaticFiles.length} static files in total.`);

    // Create a map of static files by URL for quick lookup
    const staticFilesMap = new Map();
    for (const file of allStaticFiles) {
      staticFilesMap.set(file.url, file);
    }

    // Get local sketches
    const { sketches, staticFiles } = getSketches(config.sketchesFolder);
    const localSketchNames = sketches.map((sketchPath) =>
      path.basename(sketchPath)
    );

    // Create a map to track static files for each sketch during this run
    const sketchStaticFilesMap = new Map();

    // Remove sketches that aren't in local folder anymore
    if (collection) {
      for (const item of collection.items) {
        if (!item.isDeleted && !localSketchNames.includes(item.project.name)) {
          // First remove from collection
          await apiService.removeSketchFromCollection(
            collection.id,
            item.project.id
          );

          // Then delete the sketch itself
          const deleteResult = await apiService.deleteSketch(
            item.project.id,
            item.project.name
          );

          if (deleteResult) {
            log.delete(
              `Removed and deleted sketch "${item.project.name}" as it no longer exists locally`
            );
          } else {
            log.warning(
              `Removed sketch "${item.project.name}" from collection, but failed to delete it from the server`
            );
          }
        }
      }
    }

    // Process each local sketch
    for (const sketchPath of sketches) {
      const sketchName = path.basename(sketchPath);

      // Find if the sketch already exists in the collection
      const existingSketchItem = collection?.items?.find(
        (item) => !item.isDeleted && item.project.name === sketchName
      );

      // Create a structure to track static files for this sketch
      let existingSketch = null;

      if (existingSketchItem) {
        log.info(`Fetching details for existing sketch "${sketchName}"...`);
        // Get full sketch details including files
        const sketchDetails = await apiService.getSketch(
          existingSketchItem.project.id
        );

        if (sketchDetails) {
          // Initialize the sketch object
          existingSketch = {
            id: existingSketchItem.project.id,
            name: sketchName,
            staticFiles: [],
          };

          // Extract static file information from the sketch details
          if (sketchDetails.files && Array.isArray(sketchDetails.files)) {
            // Find files with URLs (these are static files)
            const staticFileEntries = sketchDetails.files.filter(
              (file) => file.fileType === "file" && file.url
            );

            // Build folder path map
            const folderPathMap = new Map();
            folderPathMap.set("", ""); // Root folder

            // Map folder IDs to paths
            sketchDetails.files.forEach((file) => {
              if (file.fileType === "folder") {
                // Find parent folder path
                const parentFolder = sketchDetails.files.find(
                  (f) => f.children && f.children.includes(file.id)
                );

                if (parentFolder) {
                  const parentPath = folderPathMap.get(parentFolder.id) || "";
                  folderPathMap.set(
                    file.id,
                    parentPath ? `${parentPath}/${file.name}` : file.name
                  );
                }
              }
            });

            // Extract static file information
            for (const file of staticFileEntries) {
              // Find parent folder
              const parentFolder = sketchDetails.files.find(
                (f) => f.children && f.children.includes(file.id)
              );

              if (parentFolder) {
                const folderPath = folderPathMap.get(parentFolder.id) || "";

                // Find size information from the static files map using URL
                let size = null;
                const staticFileInfo = staticFilesMap.get(file.url);
                if (staticFileInfo) {
                  size = staticFileInfo.size;
                }

                // Add to static files list
                existingSketch.staticFiles.push({
                  name: file.name,
                  folder: folderPath,
                  url: file.url,
                  size: size,
                });
              }
            }

            log.info(
              `Found ${existingSketch.staticFiles.length} existing static files in sketch "${sketchName}"`
            );
          }

          // Add to our tracking map
          sketchStaticFilesMap.set(sketchName, existingSketch);
        }
      }

      const { filesData, rootId } = processCodeFiles(sketchPath);
      await processStaticFiles(
        sketchPath,
        staticFiles,
        filesData,
        rootId,
        existingSketch,
        staticFilesMap
      );

      if (existingSketch) {
        await apiService.updateSketch(existingSketch.id, sketchName, filesData);
        log.success(`Updated existing sketch "${sketchName}"`);
      } else {
        const sketch = await apiService.createSketch(sketchName, filesData);
        if (sketch?.id) {
          const newSketchInfo = {
            id: sketch.id,
            name: sketchName,
            staticFiles: [],
          };

          // Process static files for the new sketch
          const sketchStaticFiles = staticFiles.get(sketchPath);
          if (sketchStaticFiles && sketchStaticFiles.length > 0) {
            for (const staticFile of sketchStaticFiles) {
              const fileData = filesData.find(
                (f) =>
                  f.fileType === "file" &&
                  f.name === path.basename(staticFile.name) &&
                  f.url
              );

              if (fileData) {
                newSketchInfo.staticFiles.push({
                  name: staticFile.name,
                  folder: staticFile.folder,
                  url: fileData.url,
                });
              }
            }
          }

          // Add to our tracking map
          sketchStaticFilesMap.set(sketchName, newSketchInfo);

          await apiService.addSketchToCollection(
            collection.id,
            sketch.id,
            sketchName
          );
          log.success(
            `Created new sketch "${sketchName}" and added to collection`
          );
        }
      }
    }

    log.success("All sketches processed successfully");
  } catch (error) {
    handleError("An error occurred:", error);
  }
};

main();
