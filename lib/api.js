const fs = require("fs");
const axios = require("axios");
const { CookieJar } = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");
const FormData = require("form-data");
const path = require("path");

const BASE_URL = "https://editor.p5js.org";

// Create a cookie jar to store session cookies
const cookieJar = new CookieJar();

// Temporarily store the userId
let userId = null;

// Wrap axios to support cookies
const axiosInstance = wrapper(
  axios.create({
    baseURL: BASE_URL,
    jar: cookieJar,
    withCredentials: true,
    headers: {
      "Content-Type": "application/json",
    },
  })
);

/**
 * Logs in to the p5.js Web Editor.
 * @param {string} username - The user's email.
 * @param {string} password - The user's password.
 */
async function login(username, password) {
  try {
    const response = await axiosInstance.post("/editor/login", {
      email: username,
      password: password,
    });

    if (response.status === 200) {
      userId = response.data.id;
      console.log("Successfully logged in.");
    } else {
      console.error(
        "Login failed:",
        response.data.message || response.statusText
      );
      process.exit(1);
    }
  } catch (error) {
    console.error(
      "Error logging in:",
      error.response ? error.response.data : error.message
    );
    process.exit(1);
  }
}

/**
 * Retrieves an existing collection or creates a new one.
 * @param {string} collectionName - The name of the collection.
 * @returns {string} The ID of the collection.
 */
async function getOrCreateCollection(collectionName) {
  try {
    // Get existing collections
    const response = await axiosInstance.get("/editor/collections");
    const collections = response.data;

    // Check if the collection already exists
    let collection = collections.find((col) => col.name === collectionName);

    if (collection) {
      console.log(
        `Collection "${collectionName}" already exists with ID ${collection.id}`
      );
    } else {
      // Create a new collection
      const createResponse = await axiosInstance.post("/editor/collections", {
        name: collectionName,
      });

      collection = createResponse.data;
      console.log(
        `Collection "${collectionName}" created with ID ${collection.id}`
      );
    }

    return collection.id;
  } catch (error) {
    console.error(
      "Error getting or creating collection:",
      error.response ? error.response.data : error.message
    );
    process.exit(1);
  }
}

/**
 * Creates a new sketch project.
 * @param {string} name - The name of the project
 * @param {object} filesData - The files data for the sketch.
 * @returns {object} The created sketch data.
 */
async function createSketch(name, filesData) {
  try {
    const requestBody = {
      name,
      files: filesData,
    };

    const response = await axiosInstance.post("/editor/projects", requestBody);
    const sketch = response.data;
    console.log(`Sketch "${name}" created with ID ${sketch.id}`);
    return sketch;
  } catch (error) {
    console.error(
      `Error creating sketch "${name}":`,
      error.response ? error.response.data : error.message
    );
  }
}

/**
 * Updates an existing sketch project.
 * @param {string} id - The ID of the project to update.
 * @param {string} name - The new name of the project.
 * @param {object} filesData - The updated files data for the sketch.
 * @returns {object} The updated sketch data.
 */
async function updateSketch(id, name, filesData) {
  try {
    const requestBody = {
      name,
      files: filesData,
    };

    const response = await axiosInstance.put(
      `/editor/projects/${id}`,
      requestBody
    );
    const sketch = response.data;
    console.log(`Sketch "${name}" updated with ID ${sketch.id}`);
    return sketch;
  } catch (error) {
    console.error(
      `Error updating sketch with ID "${id}":`,
      error.response ? error.response.data : error.message
    );
  }
}

/**
 * Adds a sketch to a specific collection.
 * @param {string} collectionId - The ID of the collection.
 * @param {string} sketchId - The ID of the sketch.
 */
async function addSketchToCollection(collectionId, sketchId, sketchName) {
  try {
    await axiosInstance.post(
      `/editor/collections/${collectionId}/${sketchId}`,
      {}
    );
    console.log(`Sketch "${sketchName}" added to collection "${collectionId}"`);
  } catch (error) {
    console.error(
      `Error adding sketch "${sketchName}" to collection:`,
      error.response ? error.response.data : error.message
    );
  }
}

/**
 * Upload a file to S3 and add it to a sketch
 * @param {string} filePath - The path to the local file
 * @param {string} sketchId - The ID of the sketch to add the file to
 * @param {string} parentId - The ID of the parent folder in the sketch
 * @returns {object} Upload result with success status and file URL
 */
async function uploadFile(filePath, sketchId, parentId) {
  try {
    // Read the file
    const fileStream = fs.createReadStream(filePath);
    const fileStats = fs.statSync(filePath);
    const fileName = path.basename(filePath);

    // Get the file type
    const fileType = getFileType(fileName);

    // Get S3 signed URL
    const signResponse = await axiosInstance.post("/editor/S3/sign", {
      name: fileName,
      type: fileType,
      size: fileStats.size,
      userId,
    });

    if (!signResponse.data || !signResponse.data.key) {
      throw new Error("Failed to get signed URL from p5.js Web Editor");
    }

    const { key } = signResponse.data;

    // Create form data for S3 upload
    const formData = new FormData();
    Object.entries(signResponse.data).forEach(([key, value]) => {
      formData.append(key, value);
    });
    formData.append("file", fileStream);

    // Upload to S3
    const s3Response = await axios.post(
      "https://assets.editor.p5js.org/",
      formData
    );

    if (s3Response.status !== 201) {
      throw new Error("Failed to upload file to S3");
    }

    const fileUrl = `https://assets.editor.p5js.org/${key}`;

    return {
      success: true,
      key,
      url: fileUrl,
    };
  } catch (error) {
    console.error(
      `Error uploading file "${filePath}"`,
      error.response ? error.response.data : error.message
    );
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Helper function to determine file type
 * @param {string} fileName - The name of the file
 * @returns {string} The MIME type of the file
 */
function getFileType(fileName) {
  const extension = fileName.split(".").pop().toLowerCase();
  const mimeTypes = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    svg: "image/svg+xml",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    mp4: "video/mp4",
    webm: "video/webm",
    pdf: "application/pdf",
  };

  return mimeTypes[extension] || "application/octet-stream";
}

module.exports = {
  login,
  getOrCreateCollection,
  createSketch,
  updateSketch,
  addSketchToCollection,
  uploadFile,
};
