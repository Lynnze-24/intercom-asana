import express from 'express';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import FormData from 'form-data';
import multer from 'multer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Asana configuration
const ASANA_TOKEN =
  '2/1212353370344534/1212340334177314:423f18d3f0b9a38f0e75513a31350873';
const ASANA_WORKSPACE = '1211014974336131';
const ASANA_PROJECT = '1212353369442239';

// Asana Custom Field GIDs - Will be automatically populated on server start
const ASANA_CUSTOM_FIELDS = {
  WALLET: null,
  PAYMENT_GATEWAY: null,
  TRANSACTION_ID: null,
  AMOUNT: null,
  AGENT_REMARK: null,
  INTERCOM_CONVERSATION_ID: null, // For webhook sync back to Intercom
  ATTACHMENT: null, // For storing attachment URLs
};

// Cache for custom field mappings
let customFieldsCache = null;

// Intercom configuration
const INTERCOM_TOKEN =
  'dG9rOmQxMmIxYTQxXzcwMDhfNGE2Ml9iODU1XzQ5MjFkNjA4NWRlZDoxOjA=';

// Asana webhook secret (will be set during webhook handshake)
let asanaWebhookSecret = null;

// Map to store Asana task ID to Intercom conversation ID
const asanaTaskToConversation = new Map();

const app = express();
const PORT = process.env.PORT || 3000;

// Configure multer for handling file uploads (store in memory)
// Asana enforces a 100MB size limit on attachments
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max file size (Asana's limit)
  },
});

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

/*
  This object defines the canvas that will display when your app initializes.
  It includes a button to create an Asana task for the contact and a file upload input.
  
  More information on these can be found in the reference docs.
  Canvas docs: https://developers.intercom.com/docs/references/canvas-kit/responseobjects/canvas/
  Components docs: https://developers.intercom.com/docs/references/canvas-kit/interactivecomponents/button/
*/
const initialCanvas = {
  canvas: {
    content: {
      components: [
        {
          type: 'text',
          id: 'header',
          text: 'Create Asana Task for Contact',
          align: 'center',
          style: 'header',
        },
        {
          type: 'input',
          id: 'file_upload',
          label: 'Attachments (Optional)',
          placeholder: 'Choose files to upload',
          input_type: 'file',
          save_state: 'unsaved',
          multiselect: true,
        },
        {
          type: 'button',
          label: 'Create Asana Task',
          style: 'primary',
          id: 'submit_button',
          action: {
            type: 'submit',
          },
        },
      ],
    },
  },
};

// Helper function to get contact name from Intercom API
async function getContactName(contactId) {
  try {
    const response = await fetch(
      `https://api.intercom.io/contacts/${contactId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          Accept: 'application/json',
        },
      }
    );

    if (response.ok) {
      const data = await response.json();
      return data.name || 'Unknown Contact';
    }
    return 'Unknown Contact';
  } catch (error) {
    console.error('Error fetching contact from Intercom:', error);
    return 'Unknown Contact';
  }
}

// Helper function to get conversation details from Intercom API
async function getConversation(conversationId) {
  try {
    const response = await fetch(
      `https://api.intercom.io/conversations/${conversationId}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          'Intercom-Version': '2.11',
          Accept: 'application/json',
        },
      }
    );

    if (response.ok) {
      const data = await response.json();
      return data;
    }
    return null;
  } catch (error) {
    console.error('Error fetching conversation from Intercom:', error);
    return null;
  }
}

// Helper function to update Intercom conversation custom attributes
async function updateConversationAttribute(
  conversationId,
  asanaTaskId,
  attachmentUrls = null
) {
  try {
    const customAttributes = {
      AsanaTaskID: asanaTaskId,
    };

    // Add attachmentUrl if provided
    if (attachmentUrls && attachmentUrls.length > 0) {
      customAttributes.attachmentUrl = JSON.stringify(attachmentUrls);
    }

    const response = await fetch(
      `https://api.intercom.io/conversations/${conversationId}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          'Intercom-Version': '2.11',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          custom_attributes: customAttributes,
        }),
      }
    );

    if (response.ok) {
      console.log('Successfully updated conversation with Asana task ID');
      if (attachmentUrls && attachmentUrls.length > 0) {
        console.log(
          `Successfully updated conversation with ${attachmentUrls.length} attachment URL(s)`
        );
      }
      return true;
    } else {
      const errorData = await response.json();
      console.error('Error updating conversation:', errorData);
      return false;
    }
  } catch (error) {
    console.error('Error updating conversation attribute:', error);
    return false;
  }
}

// Helper function to update Intercom conversation asanaStatus field
async function updateConversationAsanaStatus(conversationId, status) {
  try {
    console.log(
      `Updating conversation ${conversationId} asanaStatus to: "${status}"`
    );

    const response = await fetch(
      `https://api.intercom.io/conversations/${conversationId}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${INTERCOM_TOKEN}`,
          'Intercom-Version': '2.11',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          custom_attributes: {
            asanaStatus: status,
          },
        }),
      }
    );

    if (response.ok) {
      console.log(`✓ Successfully updated asanaStatus to "${status}"`);
      return true;
    } else {
      const errorData = await response.json();
      console.error('✗ Error updating asanaStatus:', errorData);
      return false;
    }
  } catch (error) {
    console.error('Error updating asanaStatus:', error);
    return false;
  }
}

// Helper function to get custom field settings for a project
async function getAsanaCustomFields() {
  try {
    const response = await fetch(
      `https://app.asana.com/api/1.0/projects/${ASANA_PROJECT}/custom_field_settings`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${ASANA_TOKEN}`,
          Accept: 'application/json',
        },
      }
    );

    if (response.ok) {
      const data = await response.json();
      return data.data;
    }
    return null;
  } catch (error) {
    console.error('Error fetching custom fields:', error);
    return null;
  }
}

// Helper function to initialize custom field mappings
async function initializeCustomFieldMappings() {
  try {
    console.log('Fetching Asana custom field mappings...');
    const customFieldSettings = await getAsanaCustomFields();

    if (!customFieldSettings || customFieldSettings.length === 0) {
      console.warn('⚠ No custom fields found in Asana project');
      console.warn(
        'Custom field syncing will be disabled. Please add custom fields to your Asana project.'
      );
      return null;
    }

    const mappings = {};
    const fieldNames = {
      Wallet: 'WALLET',
      'Payment Gateway': 'PAYMENT_GATEWAY',
      'Transaction ID': 'TRANSACTION_ID',
      Amount: 'AMOUNT',
      'Agent Remark': 'AGENT_REMARK',
      intercomConversationId: 'INTERCOM_CONVERSATION_ID',
      attachment: 'ATTACHMENT',
    };

    // Map custom field names to their GIDs
    customFieldSettings.forEach((setting) => {
      const fieldName = setting.custom_field.name;
      const fieldGid = setting.custom_field.gid;

      if (fieldNames[fieldName]) {
        const mappingKey = fieldNames[fieldName];
        mappings[mappingKey] = fieldGid;
        console.log(`✓ Mapped "${fieldName}" → ${fieldGid}`);
      }
    });

    // Update the global ASANA_CUSTOM_FIELDS object
    Object.keys(mappings).forEach((key) => {
      ASANA_CUSTOM_FIELDS[key] = mappings[key];
    });

    // Check which fields are missing
    const missingFields = Object.keys(fieldNames).filter(
      (name) => !mappings[fieldNames[name]]
    );

    if (missingFields.length > 0) {
      console.warn(
        '⚠ Missing custom fields in Asana project:',
        missingFields.join(', ')
      );
      console.warn(
        'Please create these fields in your Asana project for full syncing.'
      );
    } else {
      console.log('✓ All custom fields mapped successfully');
    }

    customFieldsCache = mappings;
    return mappings;
  } catch (error) {
    console.error('Error initializing custom field mappings:', error);
    return null;
  }
}

// Helper function to validate if string is a valid URL
function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (err) {
    return false;
  }
}

// Helper function to upload attachment to Asana task from buffer
// Using multipart/form-data as required by Asana API
// Reference: https://developers.asana.com/reference/createattachmentforobject
async function uploadBufferToAsana(taskId, fileBuffer, fileName, contentType) {
  try {
    console.log('===== ASANA UPLOAD FROM BUFFER =====');
    console.log('Uploading to Asana task ID:', taskId);
    console.log('Original file name:', fileName);
    console.log('Content type:', contentType);
    console.log('File size:', fileBuffer.length, 'bytes');

    // Encode filename for non-ASCII characters (as per Asana API requirements)
    // Example: résumé.pdf becomes r%C3%A9sum%C3%A9.pdf
    const encodedFileName = encodeURIComponent(fileName);
    console.log('Encoded file name:', encodedFileName);

    // Create multipart/form-data for upload
    // Asana API requires:
    // - parent: the task/object GID
    // - file: the file content with proper Content-Disposition headers
    const formData = new FormData();
    formData.append('parent', taskId);
    formData.append('file', fileBuffer, {
      filename: encodedFileName,
      contentType: contentType,
    });

    // Upload to Asana using multipart/form-data
    const asanaResponse = await fetch(
      'https://app.asana.com/api/1.0/attachments',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ASANA_TOKEN}`,
          Accept: 'application/json',
          // FormData automatically sets Content-Type with boundary
          ...formData.getHeaders(),
        },
        body: formData,
      }
    );

    if (asanaResponse.ok) {
      const asanaData = await asanaResponse.json();
      const permanentUrl =
        asanaData.data.permanent_url || asanaData.data.download_url;
      console.log('✓ Successfully uploaded attachment to Asana');
      console.log('Asana permanent URL:', permanentUrl);
      console.log('====================================');
      return permanentUrl;
    } else {
      console.error('✗ Error uploading attachment to Asana');
      console.error(
        'Response status:',
        asanaResponse.status,
        asanaResponse.statusText
      );

      // Try to get error response body
      const contentType = asanaResponse.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        try {
          const errorData = await asanaResponse.json();
          console.error('Error details:', JSON.stringify(errorData, null, 2));
        } catch (e) {
          console.error('Failed to parse JSON error response');
        }
      } else {
        const errorText = await asanaResponse.text();
        console.error('Error response:', errorText);
      }
      console.error('====================================');
      return null;
    }
  } catch (error) {
    console.error('Error in uploadBufferToAsana:', error);
    console.error('Error details:', error.message);
    return null;
  }
}

// Helper function to upload attachment to Asana task from URL
async function uploadAttachmentToAsana(taskId, attachmentUrl) {
  try {
    // Validate if it's a proper URL
    if (!isValidUrl(attachmentUrl)) {
      console.error('Invalid attachment URL:', attachmentUrl);
      console.log(
        'The attachment field appears to be an ID or invalid URL. Please provide a full URL.'
      );
      return null;
    }

    // Download the file from the attachment URL
    console.log('===== ATTACHMENT DOWNLOAD PROCESS =====');
    console.log('Full attachment URL:', attachmentUrl);
    console.log('Attempting to download...');

    const fileResponse = await fetch(attachmentUrl);

    if (!fileResponse.ok) {
      console.error(
        'Failed to download attachment. Status:',
        fileResponse.status
      );
      console.error('Status Text:', fileResponse.statusText);
      return null;
    }

    console.log('✓ Successfully downloaded attachment');
    console.log('Content-Type:', fileResponse.headers.get('content-type'));
    console.log('Content-Length:', fileResponse.headers.get('content-length'));

    // Get the file buffer and content type
    const fileBuffer = await fileResponse.buffer();
    const contentType =
      fileResponse.headers.get('content-type') || 'application/octet-stream';

    // Extract filename from URL or use a default
    const urlParts = attachmentUrl.split('/');
    const fileName =
      urlParts[urlParts.length - 1].split('?')[0] || 'attachment';

    // Upload to Asana using the buffer upload function
    return await uploadBufferToAsana(taskId, fileBuffer, fileName, contentType);
  } catch (error) {
    console.error('Error in uploadAttachmentToAsana:', error);
    return null;
  }
}

// Root route - serves the HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Helper endpoint to get custom field GIDs and current mappings
app.get('/asana-custom-fields', async (req, res) => {
  try {
    const customFieldSettings = await getAsanaCustomFields();

    if (customFieldSettings) {
      const fields = customFieldSettings.map((setting) => ({
        name: setting.custom_field.name,
        gid: setting.custom_field.gid,
        type: setting.custom_field.resource_type,
        description: setting.custom_field.description,
      }));

      res.json({
        success: true,
        project_id: ASANA_PROJECT,
        all_custom_fields: fields,
        mapped_fields: {
          WALLET: ASANA_CUSTOM_FIELDS.WALLET,
          PAYMENT_GATEWAY: ASANA_CUSTOM_FIELDS.PAYMENT_GATEWAY,
          TRANSACTION_ID: ASANA_CUSTOM_FIELDS.TRANSACTION_ID,
          AMOUNT: ASANA_CUSTOM_FIELDS.AMOUNT,
          AGENT_REMARK: ASANA_CUSTOM_FIELDS.AGENT_REMARK,
          INTERCOM_CONVERSATION_ID:
            ASANA_CUSTOM_FIELDS.INTERCOM_CONVERSATION_ID,
          ATTACHMENT: ASANA_CUSTOM_FIELDS.ATTACHMENT,
        },
        message:
          'Custom fields are automatically mapped on server start. Check mapped_fields to see current mappings.',
      });
    } else {
      res.json({
        success: false,
        message: 'Failed to fetch custom fields from Asana',
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Helper endpoint to view webhook setup information
app.get('/webhook-info', (req, res) => {
  const webhookUrl = `${req.protocol}://${req.get('host')}/asana-webhook`;

  res.json({
    success: true,
    webhook_url: webhookUrl,
    webhook_secret_stored: asanaWebhookSecret ? true : false,
    project_gid: ASANA_PROJECT,
    setup_instructions: {
      step1:
        'Make sure this server is publicly accessible (use ngrok for local development)',
      step2: `Create webhook using: POST https://app.asana.com/api/1.0/webhooks`,
      step3: 'Set resource to your project GID',
      step4: `Set target to: ${webhookUrl}`,
      step5: 'The handshake will be completed automatically',
    },
    curl_example: `curl -X POST https://app.asana.com/api/1.0/webhooks \\
  -H "Authorization: Bearer ${ASANA_TOKEN}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "data": {
      "resource": "${ASANA_PROJECT}",
      "target": "${webhookUrl}"
    }
  }'`,
    task_to_conversation_mappings: asanaTaskToConversation.size,
  });
});

/*
  This is an endpoint that Intercom will POST HTTP request when a teammate inserts 
  the app into the inbox, or a new conversation is viewed.
*/
app.post('/initialize', async (req, res) => {
  console.log('Initialize endpoint hit');
  console.log('Initialize request body:', JSON.stringify(req.body, null, 2));

  const conversationId = req.body.conversation?.id;

  // Check if this conversation already has an Asana task
  if (conversationId) {
    const conversation = await getConversation(conversationId);
    const asanaTaskId = conversation?.custom_attributes?.AsanaTaskID;

    if (asanaTaskId) {
      // Conversation already has an Asana task, show completed state
      const completedCanvas = {
        canvas: {
          content: {
            components: [
              {
                type: 'text',
                id: 'success',
                text: '✓ Asana Task Already Created',
                align: 'center',
                style: 'header',
              },
              {
                type: 'text',
                id: 'task_id',
                text: `Task ID: ${asanaTaskId}`,
                align: 'center',
                style: 'paragraph',
              },
              {
                type: 'text',
                id: 'info',
                text: 'This conversation already has an Asana task associated with it.',
                align: 'center',
                style: 'paragraph',
              },
            ],
          },
        },
      };
      return res.send(completedCanvas);
    }
  }

  // No existing task, show create button
  res.send(initialCanvas);
});

/*
  When a submit action is taken in a canvas component, it will hit this endpoint.
  This endpoint creates an Asana task with the contact's name and prevents
  duplicate submissions per conversation.
  Handles both multipart form data (direct file uploads) and JSON data (file URLs).
*/
app.post('/submit', upload.array('files', 10), async (req, res) => {
  console.log('Submit endpoint hit with component_id:', req.body.component_id);
  console.log('Request body:', JSON.stringify(req.body, null, 2));
  console.log('Request files:', req.files ? req.files.length : 0);
  console.log('Content-Type:', req.headers['content-type']);

  const conversationId = req.body.conversation?.id;

  // Check if this conversation already has an Asana task
  if (conversationId) {
    const conversation = await getConversation(conversationId);
    const existingTaskId = conversation?.custom_attributes?.AsanaTaskID;

    if (existingTaskId) {
      const alreadySubmittedCanvas = {
        canvas: {
          content: {
            components: [
              {
                type: 'text',
                id: 'already_submitted',
                text: 'Task already created for this conversation',
                align: 'center',
                style: 'header',
              },
              {
                type: 'text',
                id: 'task_id',
                text: `Task ID: ${existingTaskId}`,
                align: 'center',
                style: 'paragraph',
              },
              {
                type: 'text',
                id: 'info',
                text: 'You can only create one Asana task per conversation.',
                align: 'center',
                style: 'paragraph',
              },
            ],
          },
        },
      };
      return res.send(alreadySubmittedCanvas);
    }
  }

  if (req.body.component_id === 'submit_button') {
    try {
      // Extract contact name from Intercom data
      let contactName =
        req.body.contact?.name || req.body.customer?.name || null;

      // If no name in request body, fetch from Intercom API
      if (!contactName) {
        const contactId = req.body.contact?.id || req.body.customer?.id;
        if (contactId) {
          contactName = await getContactName(contactId);
        } else {
          contactName = 'Unknown Contact';
        }
      }

      // Get full conversation details to access custom attributes
      const fullConversation = await getConversation(conversationId);
      const customAttrs = fullConversation?.custom_attributes || {};

      // Extract the 5 custom fields
      const wallet = customAttrs.Wallet || '';
      const paymentGateway = customAttrs['Payment Gateway'] || '';
      const transactionID = customAttrs['Transaction ID'] || '';
      const amount = customAttrs.Amount || '';
      const agentRemark = customAttrs['Agent Remark'] || '';

      console.log('\n===== FILE UPLOAD PROCESSING =====');

      // Check for direct file uploads (multer)
      const directFiles = req.files || [];
      console.log('Direct file uploads (req.files):', directFiles.length);

      // Check for file URLs from Intercom CDN
      let fileUrls = req.body.input_values?.file_upload || [];

      // Ensure it's an array
      if (!Array.isArray(fileUrls)) {
        fileUrls = fileUrls ? [fileUrls] : [];
      }

      // Handle different formats - Intercom may return objects with url property or direct URLs
      fileUrls = fileUrls
        .map((item) => {
          if (typeof item === 'string') {
            return item;
          } else if (item && item.url) {
            return item.url;
          }
          return null;
        })
        .filter((url) => url !== null);

      console.log('File URLs from Intercom CDN:', fileUrls.length);
      console.log(
        'Raw input_values.file_upload:',
        JSON.stringify(req.body.input_values?.file_upload)
      );
      console.log('Parsed file URLs:', JSON.stringify(fileUrls));
      console.log(
        'Total files to process:',
        directFiles.length + fileUrls.length
      );
      console.log('==================================\n');

      // Build basic task notes
      const taskNotes = `Task created from Intercom conversation ${conversationId}

Contact Information:
- Name: ${contactName}
- Email: ${req.body.contact?.email || req.body.customer?.email || 'N/A'}`;

      // Ensure custom fields are initialized (fallback if server start failed)
      if (!customFieldsCache) {
        console.log('Custom fields not initialized, initializing now...');
        await initializeCustomFieldMappings();
      }

      // Build custom fields object for Asana
      // All values must be converted to strings for Asana API
      const customFields = {};

      if (ASANA_CUSTOM_FIELDS.WALLET && wallet) {
        customFields[ASANA_CUSTOM_FIELDS.WALLET] = String(wallet);
      }
      if (ASANA_CUSTOM_FIELDS.PAYMENT_GATEWAY && paymentGateway) {
        customFields[ASANA_CUSTOM_FIELDS.PAYMENT_GATEWAY] =
          String(paymentGateway);
      }
      if (ASANA_CUSTOM_FIELDS.TRANSACTION_ID && transactionID) {
        customFields[ASANA_CUSTOM_FIELDS.TRANSACTION_ID] =
          String(transactionID);
      }
      if (ASANA_CUSTOM_FIELDS.AMOUNT && amount) {
        customFields[ASANA_CUSTOM_FIELDS.AMOUNT] = String(amount);
      }
      if (ASANA_CUSTOM_FIELDS.AGENT_REMARK && agentRemark) {
        customFields[ASANA_CUSTOM_FIELDS.AGENT_REMARK] = String(agentRemark);
      }
      // Add Intercom conversation ID for webhook sync
      if (ASANA_CUSTOM_FIELDS.INTERCOM_CONVERSATION_ID && conversationId) {
        customFields[ASANA_CUSTOM_FIELDS.INTERCOM_CONVERSATION_ID] =
          String(conversationId);
        console.log(
          'Adding conversation ID to Asana custom field:',
          conversationId
        );
      }

      console.log('Custom fields to sync:', Object.keys(customFields).length);
      if (Object.keys(customFields).length > 0) {
        console.log('Custom field values (as strings):', customFields);
      }

      // Create task payload
      const taskPayload = {
        workspace: ASANA_WORKSPACE,
        projects: [ASANA_PROJECT],
        name: contactName,
        notes: taskNotes,
      };

      // Only add custom_fields if we have any configured
      if (Object.keys(customFields).length > 0) {
        taskPayload.custom_fields = customFields;
      }

      console.log(
        'Creating Asana task with payload:',
        JSON.stringify(taskPayload, null, 2)
      );

      // Create Asana task
      const asanaResponse = await fetch('https://app.asana.com/api/1.0/tasks', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ASANA_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          data: taskPayload,
        }),
      });

      const asanaData = await asanaResponse.json();

      if (asanaResponse.ok) {
        const asanaTaskId = asanaData.data.gid;

        // Upload files to Asana if available
        const attachmentPermanentUrls = [];
        let attachmentStatus = null;
        const totalFiles = directFiles.length + fileUrls.length;

        if (totalFiles > 0) {
          console.log('\n===== FILE UPLOAD TO ASANA =====');
          console.log(`Processing ${totalFiles} file(s)`);

          const uploadPromises = [];

          // Handle direct file uploads (from req.files)
          if (directFiles.length > 0) {
            console.log(
              `Processing ${directFiles.length} direct file upload(s)`
            );
            directFiles.forEach((file) => {
              console.log(`  - ${file.originalname} (${file.size} bytes)`);
              uploadPromises.push(
                uploadBufferToAsana(
                  asanaTaskId,
                  file.buffer,
                  file.originalname,
                  file.mimetype
                )
              );
            });
          }

          // Handle file URLs (from Intercom CDN)
          if (fileUrls.length > 0) {
            console.log(
              `Processing ${fileUrls.length} file URL(s) from Intercom`
            );
            fileUrls.forEach((fileUrl) => {
              if (isValidUrl(fileUrl)) {
                console.log(`  - ${fileUrl}`);
                uploadPromises.push(
                  uploadAttachmentToAsana(asanaTaskId, fileUrl)
                );
              } else {
                console.log(`  ⚠ Invalid URL: ${fileUrl}`);
              }
            });
          }

          // Upload all files in parallel
          const uploadResults = await Promise.all(uploadPromises);
          attachmentPermanentUrls.push(
            ...uploadResults.filter((url) => url !== null)
          );

          if (attachmentPermanentUrls.length > 0) {
            console.log(
              `✓ Successfully uploaded ${attachmentPermanentUrls.length} file(s)`
            );
            attachmentStatus = 'success';

            // Store attachment URLs in Asana task custom field
            if (ASANA_CUSTOM_FIELDS.ATTACHMENT) {
              const attachmentUrlsJson = JSON.stringify(
                attachmentPermanentUrls
              );
              console.log(
                'Updating Asana task with attachment URLs:',
                attachmentUrlsJson
              );

              await fetch(
                `https://app.asana.com/api/1.0/tasks/${asanaTaskId}`,
                {
                  method: 'PUT',
                  headers: {
                    Authorization: `Bearer ${ASANA_TOKEN}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    data: {
                      custom_fields: {
                        [ASANA_CUSTOM_FIELDS.ATTACHMENT]: attachmentUrlsJson,
                      },
                    },
                  }),
                }
              );
            }
          } else {
            console.log('✗ No files were successfully uploaded');
            attachmentStatus = 'failed';
          }
          console.log('================================\n');
        } else {
          console.log('No files to upload');
        }

        // Save Asana task ID and attachment URLs to Intercom conversation
        await updateConversationAttribute(
          conversationId,
          asanaTaskId,
          attachmentPermanentUrls
        );

        // Store mapping for webhook callbacks
        asanaTaskToConversation.set(asanaTaskId, conversationId);
        console.log(
          `Stored mapping: Asana task ${asanaTaskId} → Intercom conversation ${conversationId}`
        );

        const components = [
          {
            type: 'text',
            id: 'success',
            text: '✓ Asana Task Created',
            align: 'center',
            style: 'header',
          },
          {
            type: 'text',
            id: 'task_name',
            text: `Task: ${contactName}`,
            align: 'center',
            style: 'paragraph',
          },
          {
            type: 'text',
            id: 'task_id',
            text: `Task ID: ${asanaTaskId}`,
            align: 'center',
            style: 'paragraph',
          },
        ];

        // Add attachment status if files were processed
        if (attachmentStatus) {
          let statusText = '';
          if (attachmentStatus === 'success') {
            statusText = `✓ ${attachmentPermanentUrls.length} file(s) uploaded successfully`;
          } else {
            statusText = '⚠ File upload failed';
          }

          components.push({
            type: 'text',
            id: 'attachment_status',
            text: statusText,
            align: 'center',
            style: 'paragraph',
          });
        }

        const syncedFieldsText =
          Object.keys(customFields).length > 0
            ? `✓ Synced ${
                Object.keys(customFields).length
              } custom fields to Asana`
            : '⚠ Configure ASANA_CUSTOM_FIELDS to sync custom fields';

        components.push({
          type: 'text',
          id: 'synced_fields',
          text: syncedFieldsText,
          align: 'center',
          style: 'paragraph',
        });

        const successCanvas = {
          canvas: {
            content: {
              components: components,
            },
          },
        };
        res.send(successCanvas);
      } else {
        throw new Error(
          asanaData.errors?.[0]?.message || 'Failed to create Asana task'
        );
      }
    } catch (error) {
      console.error('Error creating Asana task:', error);

      const errorCanvas = {
        canvas: {
          content: {
            components: [
              {
                type: 'text',
                id: 'error',
                text: 'Error Creating Task',
                align: 'center',
                style: 'header',
              },
              {
                type: 'text',
                id: 'error_message',
                text: error.message || 'An unexpected error occurred',
                align: 'center',
                style: 'paragraph',
              },
            ],
          },
        },
      };
      res.send(errorCanvas);
    }
  } else {
    res.send(initialCanvas);
  }
});

/*
  Asana webhook endpoint to receive task completion updates
  Handles the handshake and task status change events
*/
app.post('/asana-webhook', async (req, res) => {
  const hookSecret = req.headers['x-hook-secret'];

  // Handle webhook handshake
  if (hookSecret) {
    console.log('===== ASANA WEBHOOK HANDSHAKE =====');
    console.log('Received webhook handshake with secret:', hookSecret);

    // Store the secret for future verification
    asanaWebhookSecret = hookSecret;

    // Respond with the secret to complete handshake
    res.set('X-Hook-Secret', hookSecret);
    res.status(200).send();

    console.log('✓ Webhook handshake completed');
    console.log('===================================\n');
    return;
  }

  // Handle webhook events
  console.log('\n===== ASANA WEBHOOK EVENT =====');
  console.log('Received webhook event');

  try {
    const events = req.body.events || [];
    console.log(`Processing ${events.length} event(s)`);

    for (const event of events) {
      console.log('\nEvent details:');
      console.log('  Action:', event.action);
      console.log('  Resource type:', event.resource?.resource_type);
      console.log('  Resource GID:', event.resource?.gid);

      // Only process task completion changes
      if (
        event.resource?.resource_type === 'task' &&
        event.action === 'changed'
      ) {
        const taskId = event.resource.gid;
        console.log('  Task changed event for task:', taskId);

        // Fetch the task to get completion status and conversation ID
        console.log('  Fetching task details from Asana...');
        const taskResponse = await fetch(
          `https://app.asana.com/api/1.0/tasks/${taskId}`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${ASANA_TOKEN}`,
              Accept: 'application/json',
            },
          }
        );

        if (taskResponse.ok) {
          const taskData = await taskResponse.json();
          const isCompleted = taskData.data.completed;

          console.log('  Task completion status:', isCompleted);

          // Get conversation ID from custom fields
          let conversationId = null;
          const customFields = taskData.data.custom_fields || [];

          for (const field of customFields) {
            if (field.gid === ASANA_CUSTOM_FIELDS.INTERCOM_CONVERSATION_ID) {
              conversationId = field.text_value || field.display_value;
              console.log(
                '  Found conversation ID in custom field:',
                conversationId
              );
              break;
            }
          }

          // Fallback to in-memory map if custom field not found
          if (!conversationId) {
            conversationId = asanaTaskToConversation.get(taskId);
            if (conversationId) {
              console.log(
                '  Found conversation ID in memory map:',
                conversationId
              );
            }
          }

          if (!conversationId) {
            console.log('  ⚠ No conversation ID found for this task');
            console.log('  Skipping webhook update');
            continue;
          }

          // Update Intercom conversation based on completion status
          if (isCompleted) {
            console.log('  → Updating Intercom to "Completed"');
            await updateConversationAsanaStatus(conversationId, 'Completed');
          } else {
            console.log('  → Clearing Intercom asanaStatus');
            await updateConversationAsanaStatus(conversationId, '');
          }
        } else {
          console.error('  ✗ Failed to fetch task details');
        }
      }
    }

    console.log('================================\n');
    res.status(200).send();
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).send();
  }
});

const listener = app.listen(PORT, async () => {
  console.log(`Your app is listening on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} to view your app`);
  console.log('\n========================================');

  // Initialize custom field mappings from Asana
  await initializeCustomFieldMappings();

  console.log('========================================\n');
  console.log('✓ Server is ready to accept requests');
});
