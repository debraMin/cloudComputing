var express = require('express');
var config = require('./config');
var msRestAzure = require('ms-rest-azure');
var msMng = require('azure-arm-mediaservices');
var azureStorage = require('azure-storage');
var Sequelize = require('sequelize');
var bodyParser = require('body-parser');
var async = require('async');
const uuidv4 = require('uuid/v4');
const path = require('path');
const url = require('url');
const util = require('util');


var app = express();
var port = 3000;
var router = express.Router();

// Variables
const timeoutSeconds = 60 * 10;
const sleepInterval = 1000 * 15;
// test issues
//const inputFile = "./rotateInstructions.mp4";
const inputFile = null;
const inputUrl = "https://amssamples.streaming.mediaservices.windows.net/2e91931e-0d29-482b-a42b-9aadc93eb825/AzurePromo.mp4";
const namePrefix = "test";
const setTimeoutPromise = util.promisify(setTimeout);

// Database connection
const sequelize = new Sequelize(config.db, 'cloudComp19', 'cloudComp2019', {
  host: config.dbHost,
  dialect: 'mssql',
  dialectOptions: {
    encrypt: true
  },
  logging: false,
  pool: {
    max: 5,
    min: 0,
    acquire: 30000,
    idle: 10000
  }
});

// Import DB models
app.Video = sequelize.import("./App/Models/Video.js");
app.User = sequelize.import("./App/Models/User.js");

// Set associations between models
app.Video.belongsTo(app.User); // Adds a field userId to video
app.User.hasMany(app.Video, { as: 'Videos' }); // Need to check what this does

// Create the tables if not set up
app.Video.sync();
app.User.sync();

// Create the connection to Azure
/*
msRestAzure.loginWithServicePrincipalSecret(
  config.aadClientId, //appId
  config.aadSecret, //secret
  config.aadTenantId, //tenand
  { environment: {
    activeDirectoryResourceId: config.armAadAudience,
    resourceManagerEndpointUrl: config.armEndpoint,
    activeDirectoryEndpointUrl: config.aadEndpoint
  }},
  async function (err, credentials, subscriptions) {
    if (err) {
      console.log("Error while connecting to azure");
    }
    console.log("Connected to azure");

    amsClient = new msMng(credentials, config.subscriptionId, config.armEndpoint, { noRetryPolicy: true });
    try {
      //Get file extension
      if (inputFile) {
        inputExtension = path.extname(inputFile);
      } else {
        inputExtension = path.extname(inputUrl);
      }

      console.log("creating encoding transform...");
      let adaptiveStreamingTransform = {
        odatatype: "#Microsoft.Media.BuiltInStandardEncoderPreset",
        presetName: "AdaptiveStreaming"
      };
      let encodingTransform = await ensureTransformExists(adaptiveStreamingTransform);

      console.log("getting job input from arguments...");
      let uniqueness = uuidv4().slice(0,6);
      let input = await getJobInputFromArguments(uniqueness);
      let outputAssetName = namePrefix + '-output-' + uniqueness;
      let jobName = namePrefix + '-job-' + uniqueness;
      let locatorName = "locator" + uniqueness;

      console.log("creating output asset...");
      let outputAsset = await createOutputAsset(outputAssetName);

      console.log("submitting job...");
      let job = await submitJob(jobName, input, outputAsset.name);

      console.log("waiting for job to finish...");
      job = await waitForJobToFinish(jobName);

      if (job.state == "Finished") {
        let locator = await createStreamingLocator(outputAsset.name, locatorName);

        let urls = await getStreamingUrls(locator.name);

        console.log("deleting jobs ...");
        await amsClient.jobs.deleteMethod(config.resourceGroup, config.accountName, config.transformName, jobName);

        let jobInputAsset = input;
        if (jobInputAsset && jobInputAsset.assetName) {
          await amsClient.assets.deleteMethod(config.resourceGroup, config.accountName, jobInputAsset.assetName);
        }
      } else if (job.state == "Error") {
        console.log(`${job.name} failed. Error details:`);
        console.log(job.outputs[0].error);
      } else if (job.state == "Canceled") {
        console.log(`${job.name} was unexpectedly canceled.`);
      } else {
        console.log(`${job.name} is still in progress.  Current state is ${job.state}.`);
      }
      console.log("done with sample");
    } catch (err) {
      console.log(err);
    }
  }
) */

async function waitForJobToFinish(jobName) {
  let timeout = new Date();
  timeout.setSeconds(timeout.getSeconds() + timeoutSeconds);

  async function pollForJobStatus() {
    let job = await amsClient.jobs.get(config.resourceGroup, config.accountName, config.transformName, jobName);
    console.log(job.state);
    if (job.state == 'Finished' || job.state == 'Error' || job.state == 'Canceled') {
      return job;
    } else if (new Date() > timeout) {
      console.log(`Job ${job.name} timed out.`);
      return job;
    } else {
      await setTimeoutPromise(sleepInterval, null);
      return pollForJobStatus();
    }
  }

  return await pollForJobStatus();
}

async function submitJob(jobName, jobInput, outputAssetName) {
  let jobOutputs = [
    {
      odatatype: "#Microsoft.Media.JobOutputAsset",
      assetName: outputAssetName
    }
  ];

  return await amsClient.jobs.create(config.resourceGroup, config.accountName, config.transformName, jobName, {
    input: jobInput,
    outputs: jobOutputs
  });
}


async function getJobInputFromArguments(uniqueness) {
  if (inputFile) {
    let assetName = namePrefix + "-input-" + uniqueness;
    await createInputAsset(assetName, inputFile);
    return {
      odatatype: "#Microsoft.Media.JobInputAsset",
      assetName: assetName
    }
  } else {
    return {
      odatatype: "#Microsoft.Media.JobInputHttp",
      files: [inputUrl]
    }
  }
}

async function createOutputAsset(assetName) {
  return await amsClient.assets.createOrUpdate(config.resourceGroup, config.accountName, assetName, {});
}

// Create asset from a file
async function createInputAsset(assetName, file) {
  var asset = await amsClient.assets.createOrUpdate(config.resourceGroup, config.accountName, assetName, {});
  var date = new Date();
  date.setHours(date.getHours() + 1);
  var input = {
    permissions: "ReadWrite",
    expiryTime: date
  }
  var response = await amsClient.assets.listContainerSas(config.resourceGroup, config.accountName, assetName, input);
  let uploadSasUrl = response.assetContainerSasUrls[0] || null;
  let fileName = path.basename(file);
  let sasUri = url.parse(uploadSasUrl);
  let sharedBlobService = azureStorage.createBlobServiceWithSas(sasUri.host, sasUri.search);
  let containerName = sasUri.pathname.replace(/^\/+/g, '');
  let randomInt = Math.round(Math.random() * 100);
  blobName = fileName + randomInt;
  console.log("uploading to blob...");
  function createBlobPromise() {
    return new Promise(function (resolve, reject) {
      sharedBlobService.createBlockBlobFromLocalFile(containerName, blobName, file, resolve);
    });
  }
  await createBlobPromise();
  return asset;
}

// Create a streaminglocator
async function createStreamingLocator(assetName, locatorName) {
  let streamingLocator = {
    assetName: assetName,
    streamingPolicyName: "Predefined_ClearStreamingOnly"
  };

  let locator = await amsClient.streamingLocators.create(
    config.resourceGroup,
    config.accountName,
    locatorName,
    streamingLocator);

  return locator;
}

// Get urls for streaming content
async function getStreamingUrls(locatorName) {
  let streamingEndpoint = await amsClient.streamingEndpoints.get(config.resourceGroup, config.accountName, config.streamingEndpoint);

  let paths = await amsClient.streamingLocators.listPaths(config.resourceGroup, config.accountName, locatorName);

  for (let i = 0; i < paths.streamingPaths.length; i++) {
    let path = paths.streamingPaths[i].paths[0];
    console.log("https://" + streamingEndpoint.hostName + "//" + path);
  }
}

async function ensureTransformExists(transformName, preset) {
  let transform = await amsClient.transforms.get(config.resourceGroup, config.accountName, config.transformName);
  if (!transform) {
    transform = await amsClient.transforms.createOrUpdate(config.resourceGroup, config.accountName, config.transformName, {
      name: config.transformName,
      location: region,
      outputs: [{
        preset: preset
      }]
    });
  }
  return transform;
}

// ROUTES
// Send index page
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname + '/App/index.html'));
});

// Send stream page
router.get('/stream', (req, res) => {
  res.sendFile(path.join(__dirname + '/App/Views/Stream.html'));
});

// Send upload page
router.get('/upload', (req, res) => {
  res.sendFile(path.join(__dirname + '/App/Views/Upload.html'));
});

// Create a new asset
router.post('/upload', (req, res) => {
  res.end('Uploaded suceed');
});

app.use('/App/Content/', express.static(__dirname + '/App/Content/'));
app.use('/App/Views/', express.static(__dirname + '/App/Views/'));

app.use('/', router);

// Start server
app.listen(port, (err) => {
  if (err) {
    return console.log('something bad happened', err);
  }
  console.log(`server is listening on ${port}`);
});