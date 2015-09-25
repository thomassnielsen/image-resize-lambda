// Based on:
// http://stackoverflow.com/questions/30876345/in-amazon-lambda-resizing-multiple-thumbnail-sizes-in-parallel-async-throws-err

// dependencies
var async = require('async');
var AWS = require('aws-sdk');
var gm = require('gm')
  .subClass({
    imageMagick: true
  }); // Enable ImageMagick integration.
var util = require('util');

// constants
var SIZES = ['full', 100, 320, 640, 768, 960, 1024, 1440];

exports.handler = function(event, context) {

  // Read options from the event.
  console.log("Reading options from event:\n", util.inspect(event, {
    depth: 5
  }));
  var srcBucket = event.Records[0].s3.bucket.name;
  var srcKey = event.Records[0].s3.object.key;
  var region = event.Records[0].awsRegion;
  var dstBucket = srcBucket;

  // get reference to S3 client
  var s3 = new AWS.S3({
    region: region
  });

  console.log('S3 configured with endpoint ' + s3.endpoint.href);

  // Infer the image type.
  var typeMatch = srcKey.match(/\.([^.]*)$/);
  if (!typeMatch) {
    console.error('unable to infer image type for key ' + srcKey);
    return context.done();
  }
  var imageType = typeMatch[1];
  if (imageType != "jpg" && imageType != "jpeg" && imageType != "png") {
    console.log('skipping non-image ' + srcKey);
    return context.done();
  }

  // Download the image from S3
  s3.getObject({
      Bucket: srcBucket,
      Key: srcKey
    },
    function(err, response) {

      if (err)
        return console.error('unable to download image ' + err);

      var contentType = response.ContentType;

      var original = gm(response.Body);

      original.size(function(err, size) {

        if (err)
          return console.error(err);

        //transform, and upload to a different S3 bucket.
        async.each(SIZES,
          function(max_size, callback) {
            resize_photo(size, max_size, imageType, original, srcKey, dstBucket, contentType, s3, callback);
          },
          function(err) {
            if (err) {
              console.error(
                'Unable to resize ' + srcBucket +
                ' due to an error: ' + err
              );
            } else {
              console.log(
                'Successfully resized ' + srcBucket
              );
            }

            context.done();
          });
      });


    });



};

//wrap up variables into an options object
var resize_photo = function(size, max_size, imageType, original, srcKey, dstBucket, contentType, s3, done) {

  var parts = srcKey.split("/");
  var filename = parts[parts.length - 1];
  var dstKey = "public/" + max_size + "/" + filename;

  console.log("Creating version " + dstKey);


  // transform, and upload to a different S3 bucket.
  async.waterfall([

    function transform(next) {
      if (max_size == 'full') {
        original.toBuffer(imageType, function(err, buffer) {
          next(null, buffer);
        });
        return;
      }

      // Infer the scaling factor to avoid stretching the image unnaturally.
      // We use Math.max because we want to fill the smallest side
      var scalingFactor = Math.max(
        max_size / size.width,
        max_size / size.height
      );

      // No need to waste resources upscaling.
      if (scalingFactor > 1) {
        original.toBuffer(imageType, function(err, buffer) {
          next(null, buffer);
        });
        return;
      }
      var width = scalingFactor * size.width;
      var height = scalingFactor * size.height;

      // Transform the image buffer in memory.
      original.resize(width, height)
        .toBuffer(imageType, function(err, buffer) {

          if (err) {
            next(err);
          } else {
            next(null, buffer);
          }
        });
    },
    function upload(data, next) {
      // Stream the transformed image to a different S3 bucket.
      s3.putObject({
          Bucket: dstBucket,
          Key: dstKey,
          Body: data,
          ContentType: contentType
        },
        next);
    }
  ], function(err) {

    console.log('finished resizing ' + dstBucket + '/' + dstKey);

    if (err) {
      console.error(err);
    } else {
      console.log(
        'Successfully resized ' + dstKey
      );
    }

    done(err);
  });
};
