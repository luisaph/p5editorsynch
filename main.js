const fs = require("fs");
const path = require("path");
const objectID = require("bson-objectid");
const core = require("@actions/core");
require("dotenv").config();

const apiService = require("./lib/api");
const { getSketches } = require("./lib/util");

const P5_USERNAME = core.getInput("p5-username") || process.env.P5_USERNAME;
const P5_PASSWORD = core.getInput("p5-password") || process.env.P5_PASSWORD;
const SKETCHES_FOLDER = path.join(
  process.cwd(),
  core.getInput("sketch-folder") || process.env.SKETCHES_FOLDER || "sketches"
);
const SKETCH_INFO_FILE = path.join(SKETCHES_FOLDER, "sketchesMap.json");
const COLLECTION_NAME =
  core.getInput("collection-name") ||
  process.env.COLLECTION_NAME ||
  "My Sketches";

(async () => {
  if (!P5_USERNAME || !P5_PASSWORD) {
    console.error(
      "No username or password provided. Please set the P5_USERNAME and P5_PASSWORD environment variables."
    );
    process.exit(1);
  }

  if (!fs.existsSync(SKETCHES_FOLDER)) {
    console.error(
      `The "${SKETCHES_FOLDER}" folder does not exist. Please check is "SKETCHES_FOLDER" set correctly.`
    );
    process.exit(1);
  }

  // Login
  await apiService.login(P5_USERNAME, P5_PASSWORD);

  // Get or create the collection
  const collectionId = await apiService.getOrCreateCollection(COLLECTION_NAME);

  // Load existing sketch information
  const sketchesInfo = fs.existsSync(SKETCH_INFO_FILE)
    ? JSON.parse(fs.readFileSync(SKETCH_INFO_FILE, "utf8"))
    : [];

  // Get the list of sketch directories
  const sketches = getSketches(SKETCHES_FOLDER)

  for (const sketchPath of sketches) {
    const sketchName = path.basename(sketchPath);
  
    // Read all files in the sketch folder
    const files = fs.readdirSync(sketchPath).filter((file) => {
      const fileExtension = path.extname(file).toLowerCase();
      return (
        fs.statSync(path.join(sketchPath, file)).isFile() &&
        [".html", ".css", ".js", ".json"].includes(fileExtension)
      );
    });

    // Build the files object for the API request
    const filesData = [];
    const children = [];

    files.forEach((fileName) => {
      const filePath = path.join(sketchPath, fileName);
      const content = fs.readFileSync(filePath, "utf8");

      const id = objectID().toHexString();
      children.push(id);

      filesData.push({
        id,
        _id: id,
        name: fileName,
        content: content,
        fileType: "file",
        isSelectedFile: fileName === "sketch.js",
        children: [],
      });
    });

    const id = objectID().toHexString();

    filesData.unshift({
      id,
      _id: id,
      name: "root",
      content: "",
      fileType: "folder",
      children,
    });

    const existingSketch = sketchesInfo.find(
      (item) => item.name === sketchName
    );

    if (existingSketch) {
      // Update the Sketch
      await apiService.updateSketch(existingSketch.id, sketchName, filesData);
    } else {
      // Create the sketch
      const sketch = await apiService.createSketch(sketchName, filesData);

      sketchesInfo.push({
        id: sketch.id,
        name: sketchName,
      });

      if (sketch && sketch.id) {
        // Add the sketch to the collection
        await apiService.addSketchToCollection(
          collectionId,
          sketch.id,
          sketchName
        );
      }
    }
  }

  // Save updated sketch information to JSON file
  try {
    fs.writeFileSync(
      SKETCH_INFO_FILE,
      JSON.stringify(sketchesInfo, null, 2),
      "utf8"
    );
  } catch (error) {
    console.error("Error writing to file:", error);
  }
})();
