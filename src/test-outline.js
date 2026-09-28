require("dotenv").config();

const { testOutlineConnection } = require("./outline");

testOutlineConnection()
  .then(() => {
    console.log("Outline API connection and certificate verified.");
  })
  .catch(() => {
    console.error("Outline API connection or certificate verification failed.");
    process.exitCode = 1;
  });
